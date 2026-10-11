/**
 * Semantic retrieval over the indexed documentation.
 *
 * The query is embedded with the same sentence-transformer used at ingestion
 * time and compared against every stored passage using cosine distance. What
 * comes back is the stored text verbatim - nothing here generates, rewrites,
 * summarises or "answers" anything.
 *
 * A similarity score measures how close two texts are in embedding space. It
 * is a ranking signal, not a measure of correctness.
 */
import { query } from "./db";
import { embedOne, toVectorLiteral } from "./embed";
import { optionalEnvNumber } from "./env";
import { SOURCE_IDS, type SourceId } from "../ingest/sources";

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
  similarity: number;
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
  /** Highest score seen before the threshold, useful for messaging. */
  bestScore: number | null;
  durationMs: number;
}

export const DEFAULT_LIMIT = optionalEnvNumber("SEARCH_TOP_K", 8);
export const DEFAULT_THRESHOLD = optionalEnvNumber("SEARCH_THRESHOLD", 0.25);

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
  similarity: number;
}

export async function search(params: SearchParams): Promise<SearchResponse> {
  const started = Date.now();
  const source = params.source ?? "all";
  const limit = Math.min(MAX_LIMIT, Math.max(1, params.limit ?? DEFAULT_LIMIT));
  const threshold = params.threshold ?? DEFAULT_THRESHOLD;

  const vector = await embedOne(params.query);
  const literal = toVectorLiteral(vector);

  // Cosine distance is 1 - similarity for L2-normalised vectors, so the
  // threshold becomes a distance ceiling. The source filter is applied inside
  // the query so it never has to be done client-side.
  const rows = await query<RawHit>(
    `SELECT
       c.id                                        AS chunk_id,
       c.source                                    AS source,
       s.label                                     AS source_label,
       s.color                                     AS source_color,
       s.license                                   AS source_license,
       d.url                                       AS url,
       d.title                                     AS title,
       d.section_title                             AS section_title,
       d.heading_path                              AS heading_path,
       d.version                                   AS version,
       c.text                                      AS text,
       1 - (c.embedding <=> $1::vector)            AS similarity
     FROM chunks c
     JOIN documents d ON d.id = c.document_id
     JOIN sources   s ON s.id = c.source
     WHERE (c.embedding <=> $1::vector) <= (1 - $2::float8)
       AND ($3::text IS NULL OR c.source = $3)
     ORDER BY c.embedding <=> $1::vector
     LIMIT $4::int`,
    [literal, threshold, source === "all" ? null : source, limit],
  );

  const results: SearchHit[] = rows.map((row) => ({
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
    similarity: Number(row.similarity),
  }));

  return {
    query: params.query,
    filters: { source, limit, threshold },
    results,
    empty: results.length === 0,
    bestScore: results.length > 0 ? results[0].similarity : null,
    durationMs: Date.now() - started,
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
