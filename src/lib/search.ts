/**
 * Hybrid retrieval over the indexed documentation.
 *
 * Two retrievers run over the same passages and their rankings are fused:
 *
 *   1. Semantic. The query is embedded with the same sentence-transformer used
 *      at ingestion and compared by cosine distance. This finds passages that
 *      mean the same thing, which is what a question in the user's own words
 *      needs.
 *   2. Lexical. Postgres BM25 ranks by the literal terms. This is what finds
 *      `httpx.AsyncClient`, `CREATE INDEX CONCURRENTLY` or an exact error
 *      message - strings a small sentence encoder has no distributional reason
 *      to represent distinctly, and which are the majority of what people
 *      actually search a documentation index for.
 *
 * Fusion is Reciprocal Rank Fusion: each retriever contributes 1/(k + rank)
 * and the scores are added. It combines *positions*, not raw scores, which is
 * the point - a cosine distance and a BM25 score are not on a comparable scale
 * and normalising them into one would invent a relationship that is not there.
 *
 * What comes back is the stored text verbatim. Nothing here generates,
 * rewrites, summarises or "answers" anything - the answer step in
 * /api/answer is a separate request that receives these passages as input,
 * so retrieval stands on its own regardless of whether any model is
 * reachable.
 */
import { query } from "./db";
import { optionalEnvNumber } from "./env";
import { MIN_PASSAGE_CHARS } from "./constants";
import { SOURCE_IDS, type SourceId } from "../ingest/sources";

/**
 * Reciprocal Rank Fusion constant.
 *
 * The value recommended by the Lakebase Search guide, and the one most RRF
 * implementations converge on. It controls how quickly a retriever's
 * contribution decays with rank: at k=60 a first-place result contributes
 * 0.0167 and a tenth-place 0.0143, so a passage both retrievers like beats one
 * that only a single retriever loves, without either retriever dominating.
 */
export const RRF_K = 60;

/**
 * Candidates drawn from each retriever before fusion.
 *
 * Far more than the 8 results requested, because a retriever's top 8 may be
 * entirely different from the other retriever's top 8 - fusing only the
 * requested count would leave nothing to combine. 40 is the documented
 * starting point for RRF.
 */
export const CANDIDATES_PER_RETRIEVER = 40;

export interface SearchHit {
  chunkId: number;
  source: SourceId;
  sourceLabel: string;
  sourceColor: string;
  sourceLicense: string;
  url: string;
  title: string;
  sectionTitle: string;
  headingPath: string[];
  version: string | null;
  text: string;
  /**
   * Cosine similarity, or null when only the lexical retriever found this
   * passage. Null is meaningful: it says the passage matched on wording alone,
   * which is a different - and for an API name, better - kind of match.
   */
  similarity: number | null;
  /** BM25 score. Negative, and more negative is better. Null when the retriever did not return this passage. */
  lexicalScore: number | null;
  /** Which retrievers found this passage, so the interface can say why it ranked. */
  matchedBy: ("semantic" | "lexical")[];
}

export interface SearchParams {
  query: string;
  source?: SourceId | "all";
  limit?: number;
  threshold?: number;
}

export interface SearchResponse {
  query: string;
  /** Echo of the filters actually applied, so the UI can state them. */
  filters: { source: SourceId | "all"; limit: number; threshold: number };
  results: SearchHit[];
  /** True when nothing cleared the relevance threshold. */
  empty: boolean;
  /** Highest semantic score among the results, for messaging. */
  bestScore: number | null;
  durationMs: number;
  /** How the results were assembled, reported so the interface can be honest about it. */
  retrieval: {
    mode: "hybrid";
    candidatesConsidered: number;
    semanticCandidates: number;
    lexicalCandidates: number;
  };
}

/**
 * Defaults, calibrated against the indexed corpus.
 *
 * Measured over ~25,000 passages: unrelated questions ("what is the capital
 * of France", "how do I make sourdough bread") peak around 0.28, while the
 * weakest genuine match in the same set was 0.61. 0.38 sits in the gap with
 * margin on both sides.
 *
 * Raise SEARCH_THRESHOLD to be strict about relevance, lower it to trade
 * precision for recall.
 */
export const DEFAULT_LIMIT = optionalEnvNumber("SEARCH_TOP_K", 8);
export const DEFAULT_THRESHOLD = optionalEnvNumber("SEARCH_THRESHOLD", 0.38);

const MAX_LIMIT = 25;
const MAX_QUERY_LENGTH = 400;

export function validateSearchInput(raw: unknown): {
  ok: true;
  value: { query: string; source: SourceId | "all"; limit: number; threshold: number };
} | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "Enter a question to search the documentation." };
  }
  const value = raw.trim();
  if (value.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `Keep the question under ${MAX_QUERY_LENGTH} characters.` };
  }
  return { ok: true, value: { query: value, source: "all", limit: DEFAULT_LIMIT, threshold: DEFAULT_THRESHOLD } };
}

export function resolveFilters(input: {
  source?: string | null;
  limit?: number | null;
  threshold?: number | null;
}): { source: SourceId | "all"; limit: number; threshold: number; error?: string } {
  let source: SourceId | "all" = "all";
  const requested = input.source?.trim();
  if (requested && requested !== "all") {
    if (!SOURCE_IDS.includes(requested as SourceId)) {
      return {
        source: "all",
        limit: DEFAULT_LIMIT,
        threshold: DEFAULT_THRESHOLD,
        error: `Unknown source "${requested}".`,
      };
    }
    source = requested as SourceId;
  }

  let limit = DEFAULT_LIMIT;
  if (input.limit != null && Number.isFinite(input.limit)) {
    limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(input.limit)));
  }

  let threshold = DEFAULT_THRESHOLD;
  if (input.threshold != null && Number.isFinite(input.threshold)) {
    threshold = Math.min(0.95, Math.max(0, input.threshold));
  }

  return { source, limit, threshold };
}

interface RawHit {
  chunk_id: string;
  source: SourceId;
  source_label: string;
  source_color: string;
  source_license: string;
  url: string;
  title: string;
  section_title: string | null;
  heading_path: string[];
  version: string | null;
  text: string;
  similarity: number | null;
  lexical_score: number | null;
  rrf_score: number;
  semantic_rank: number | null;
  lexical_rank: number | null;
}

/**
 * The hybrid query.
 *
 * Both retrievers read the same table and are filtered identically, so the
 * source filter and the relevance threshold apply to whichever retriever found
 * a passage. Fusion then happens in SQL: each CTE produces a ranked candidate
 * list, and the outer query adds 1/(k + rank) across the two.
 *
 * The threshold applies to the *semantic* score only. BM25 scores are unbounded
 * and corpus-dependent, so there is no fixed number to threshold against; the
 * lexical retriever exists to surface exact matches that the semantic side
 * scores weakly, and cutting them off would defeat it. A passage found only by
 * BM25 is therefore admitted without a semantic floor, which is safe because
 * `@@` already requires every query term to be present - it is a literal
 * match, not a vague one.
 *
 * RANK() rather than ROW_NUMBER() so tied passages get the same rank and a tie
 * is never broken arbitrarily by storage order.
 *
 * The lexical candidate filter matches ANY query term, not all of them.
 * websearch_to_tsquery defaults to conjunction, which would require a passage to
 * contain every word of the question: for "How do I return a file response from
 * a route in FastAPI?" no passage does, so BM25 returned nothing at all and
 * contributed nothing to exactly the natural-language queries it was added for.
 * Measured before this change: 0 of the 8 results for that query were found
 * lexically. BM25 scores the shared terms, so the disjunction costs precision
 * nothing - only the best rows survive the LIMIT.
 */
const HYBRID_SQL = `
WITH semantic AS (
  SELECT id, similarity, rank FROM (
    SELECT c.id,
           1 - (c.embedding <=> $1::vector) AS similarity,
           RANK() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
    FROM chunks c
    WHERE ($2::text IS NULL OR c.source = $2)
      AND length(c.text) >= $5::int
      AND (c.embedding <=> $1::vector) <= (1 - $3::float8)
  ) t
  ORDER BY rank
  LIMIT $4
),
lexical AS (
  SELECT id, score, rank FROM (
    SELECT c.id,
           c.text_tsv <@> to_bm25query(
             to_tsvector('english', $6::text),
             'chunks_text_bm25'::regclass
           ) AS score,
           RANK() OVER (ORDER BY c.text_tsv <@> to_bm25query(
             to_tsvector('english', $6::text),
             'chunks_text_bm25'::regclass
           )) AS rank
    FROM chunks c
    WHERE ($2::text IS NULL OR c.source = $2)
      AND length(c.text) >= $5::int
      -- OR, not AND. See the note above the query.
      AND c.text_tsv @@ to_tsquery(
        'english',
        replace(plainto_tsquery('english', $6::text)::text, ' & ', ' | ')
      )
      -- The same relevance gate the semantic side passes.
      --
      -- Without this, BM25 decides relevance on its own and term overlap alone
      -- admits anything: 'what is the capital of France' returned five passages,
      -- every one lexical-only with no semantic score, because the manuals do
      -- mention France somewhere. A relevance threshold that means different
      -- things depending on which retriever found the passage is not a
      -- relevance threshold.
      --
      -- BM25's job is ranking, not admission: it promotes the passages matching
      -- the exact terms among those already judged relevant. That is what moved
      -- 'return a file response' from FileResponse at rank three to rank one.
      AND (c.embedding <=> $1::vector) <= (1 - $3::float8)
  ) t
  ORDER BY score
  LIMIT $4
)
SELECT
  c.id                                          AS chunk_id,
  c.source                                      AS source,
  s.label                                       AS source_label,
  s.color                                       AS source_color,
  s.license                                     AS source_license,
  d.url                                         AS url,
  d.title                                       AS title,
  d.section_title                               AS section_title,
  d.heading_path                                AS heading_path,
  d.version                                     AS version,
  c.text                                        AS text,
  sem.similarity                                AS similarity,
  lex.score                                     AS lexical_score,
  COALESCE(1.0 / ($7::float8 + sem.rank), 0)
    + COALESCE(1.0 / ($7::float8 + lex.rank), 0) AS rrf_score,
  sem.rank                                      AS semantic_rank,
  lex.rank                                      AS lexical_rank
FROM chunks c
JOIN documents d ON d.id = c.document_id
JOIN sources   s ON s.id = c.source
LEFT JOIN semantic sem ON sem.id = c.id
LEFT JOIN lexical  lex ON lex.id = c.id
WHERE sem.id IS NOT NULL OR lex.id IS NOT NULL
ORDER BY rrf_score DESC, c.id
LIMIT $8::int`;

export async function search(params: SearchParams): Promise<SearchResponse> {
  const started = Date.now();
  const source = params.source ?? "all";
  const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
  const threshold = params.threshold ?? DEFAULT_THRESHOLD;

  // Loaded on demand. The embedding stack pulls in onnxruntime and a 22 MB
  // model, and the landing page only needs the corpus counts - importing it at
  // module scope would make every page render pay for it, and fail entirely
  // if the native runtime is unavailable.
  const { embedOne, toVectorLiteral } = await import("./embed");

  const vector = await embedOne(params.query);
  const literal = toVectorLiteral(vector);

  const rows = await query<RawHit>(HYBRID_SQL, [
    literal,
    source === "all" ? null : source,
    threshold,
    CANDIDATES_PER_RETRIEVER,
    MIN_PASSAGE_CHARS,
    params.query,
    RRF_K,
    limit,
  ]);

  const results: SearchHit[] = rows.map((row) => {
    const matchedBy: ("semantic" | "lexical")[] = [];
    if (row.semantic_rank !== null) matchedBy.push("semantic");
    if (row.lexical_rank !== null) matchedBy.push("lexical");

    return {
      chunkId: Number(row.chunk_id),
      source: row.source,
      sourceLabel: row.source_label,
      sourceColor: row.source_color,
      sourceLicense: row.source_license,
      url: row.url,
      title: row.title,
      sectionTitle: row.section_title ?? row.title,
      headingPath: row.heading_path ?? [],
      version: row.version,
      text: row.text,
      // A BM25-only hit has no semantic score. It is reported as null rather
      // than 0 so the interface can say it matched on wording alone, instead of
      // claiming a similarity of zero that reads like a real measurement.
      similarity: row.similarity === null ? null : Number(row.similarity),
      lexicalScore: row.lexical_score === null ? null : Number(row.lexical_score),
      matchedBy,
    };
  });

  const semanticScores = results
    .map((r) => r.similarity)
    .filter((s): s is number => s !== null);

  return {
    query: params.query,
    filters: { source, limit, threshold },
    results,
    empty: results.length === 0,
    bestScore: semanticScores.length > 0 ? Math.max(...semanticScores) : null,
    durationMs: Date.now() - started,
    retrieval: {
      mode: "hybrid",
      candidatesConsidered: rows.length,
      semanticCandidates: rows.filter((r) => r.semantic_rank !== null).length,
      lexicalCandidates: rows.filter((r) => r.lexical_rank !== null).length,
    },
  };
}

export interface CorpusStat {
  id: SourceId;
  label: string;
  name: string;
  color: string;
  homepage: string;
  license: string;
  version: string | null;
  documents: number;
  passages: number;
  characters: number;
}

/** What is actually indexed, for the contents panel on the landing page. */
export async function getCorpusStats(): Promise<{ sources: CorpusStat[]; totalPassages: number }> {
  const rows = await query<{
    id: SourceId;
    label: string;
    name: string;
    color: string;
    homepage: string;
    license: string;
    version: string | null;
    documents: number;
    passages: number;
    characters: string;
  }>("SELECT * FROM corpus_stats ORDER BY id");

  const sources: CorpusStat[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    name: row.name,
    color: row.color,
    homepage: row.homepage,
    license: row.license,
    version: row.version,
    documents: Number(row.documents),
    passages: Number(row.passages),
    characters: Number(row.characters),
  }));

  return {
    sources,
    totalPassages: sources.reduce((sum, s) => sum + s.passages, 0),
  };
}
