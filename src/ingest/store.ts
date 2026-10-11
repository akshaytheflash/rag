/**
 * Persistence for the retrieval index.
 *
 * Design goal: running ingestion twice must not duplicate anything, and must
 * converge on the current state of the documentation.
 *
 *   documents  keyed by (source, url, anchor)  - stable identity for a section
 *   chunks     keyed by (document_id, ordinal)  - stable position in a section
 *
 * Re-ingesting a page therefore upserts in place. Chunks whose content is
 * unchanged keep their embedding: the pipeline compares content hashes before
 * recomputing, so an incremental run only pays for what actually moved.
 */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { query } from "../lib/db";
import type { ExtractedPage, Section } from "./extract";
import { chunkPage, type ChunkOptions, DEFAULT_CHUNK_OPTIONS } from "./chunk";
import type { SourceId } from "./sources";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** NUL cannot occur in extracted documentation text, so the key is unambiguous. */
const SEP = String.fromCharCode(0);

/**
 * Identity of a passage, content-addressed across source, canonical URL,
 * section anchor and text. Exported so tests can assert against the real key
 * format instead of duplicating it.
 */
export const chunkContentHash = (
  source: string,
  canonicalUrl: string,
  anchor: string,
  text: string,
): string => sha256(`${source}${SEP}${canonicalUrl}${SEP}${anchor}${SEP}${text}`);

/**
 * heading_path is a text[] in the schema, but passing an array-of-arrays
 * through UNNEST loses the element type. Encoding each path as one delimited
 * string and splitting it back in SQL is unambiguous and avoids the whole
 * class of array typing problems.
 */
const PATH_SEPARATOR = String.fromCharCode(31); // chr(31), matches the SQL side

export const encodePath = (headingPath: string[]): string => headingPath.join(PATH_SEPARATOR);

export const decodePath = (encoded: string): string[] =>
  encoded ? encoded.split(PATH_SEPARATOR) : [];

export interface PreparedChunk {
  ordinal: number;
  headingPath: string[];
  text: string;
  tokenEstimate: number;
  contentHash: string;
}

export interface PreparedDocument {
  source: SourceId;
  url: string;
  canonicalUrl: string;
  anchor: string;
  title: string;
  headingPath: string[];
  sectionTitle: string;
  version: string | null;
  contentHash: string;
  chunks: PreparedChunk[];
}

/**
 * Builds the database rows for one page without touching the database.
 *
 * `occurrence` disambiguates sections that would otherwise share a natural
 * key. Many documentation pages repeat the same heading text (or have no id
 * attribute at all), and because the key is (source, url, anchor) two such
 * sections collide - which Postgres rejects outright with "ON CONFLICT DO
 * UPDATE command cannot affect row a second time".
 */
export async function prepareDocument(
  source: SourceId,
  page: ExtractedPage,
  section: Section,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
  occurrence = 0,
): Promise<PreparedDocument> {
  // One document row per section; its anchor keeps the natural key stable.
  const baseAnchor = section.anchor || sha256(section.headingPath.join(" / ")).slice(0, 16);
  const anchor = occurrence === 0 ? baseAnchor : `${baseAnchor}~${occurrence}`;

  const chunked = await chunkPage([{ ...section, blocks: section.blocks }], options);

  const chunks: PreparedChunk[] = chunked.map((chunk) => ({
    ordinal: chunk.ordinal,
    headingPath: chunk.headingPath,
    text: chunk.pageContent,
    tokenEstimate: chunk.tokenEstimate,
    contentHash: chunkContentHash(source, page.canonicalUrl, anchor, chunk.pageContent),
  }));

  return {
    source,
    url: page.canonicalUrl,
    canonicalUrl: page.canonicalUrl,
    anchor,
    title: page.title,
    headingPath: section.headingPath,
    sectionTitle: section.title,
    version: page.version,
    contentHash: sha256(chunks.map((c) => c.contentHash).join("|")),
    chunks,
  };
}

export interface PersistStats {
  documentsUpserted: number;
  chunksInserted: number;
  chunksUpdated: number;
  chunksDeleted: number;
  embeddingsComputed: number;
}

/**
 * Upserts a batch of documents and their chunks in a single transaction.
 *
 * Batching matters here. Neon sits in us-east-2 and a round trip costs a few
 * hundred milliseconds, so issuing one transaction per document turned a small
 * ingest into a multi-minute job. Writing N documents in a handful of
 * set-based statements keeps the run proportional to the data, not the latency.
 *
 * `embedBatch` is only invoked for chunks whose content hash changed, which is
 * what makes re-running the pipeline cheap.
 */
export async function persistDocuments(
  client: PoolClient,
  docs: PreparedDocument[],
  embedBatch: (texts: string[]) => Promise<number[][]>,
  stats: PersistStats,
): Promise<void> {
  if (docs.length === 0) return;

  // Two distinct fetched URLs can declare the same canonical URL. Keep the
  // last occurrence of each natural key: Postgres refuses a statement that
  // would touch the same conflicting row twice, and losing one duplicate
  // beats aborting the whole batch.
  const byKey = new Map<string, PreparedDocument>();
  for (const doc of docs) {
    byKey.set(`${doc.source}${SEP}${doc.url}${SEP}${doc.anchor}`, doc);
  }
  const unique = [...byKey.values()];
  if (unique.length !== docs.length) {
    console.warn(
      `  ! ${docs.length - unique.length} section(s) shared a canonical URL and anchor; kept one of each`,
    );
  }
  docs = unique;

  // 1. Upsert every document row in one statement.
  const { rows: docRows } = await client.query<{ id: string; source: string; url: string; anchor: string }>(
    `INSERT INTO documents (source, url, anchor, title, heading_path, section_title, version, content_hash)
     SELECT d.source, d.url, d.anchor, d.title,
            CASE WHEN d.heading_path_enc = '' THEN '{}'::text[]
                 ELSE string_to_array(d.heading_path_enc, chr(31)) END,
            d.section_title, d.version, d.content_hash
     FROM UNNEST(
       $1::text[], $2::text[], $3::text[], $4::text[],
       $5::text[], $6::text[], $7::text[], $8::text[]
     ) AS d(source, url, anchor, title, heading_path_enc, section_title, version, content_hash)
     ON CONFLICT (source, url, anchor) DO UPDATE SET
       title         = EXCLUDED.title,
       heading_path  = EXCLUDED.heading_path,
       section_title = EXCLUDED.section_title,
       version       = EXCLUDED.version,
       content_hash  = EXCLUDED.content_hash,
       fetched_at    = now()
     RETURNING id, source, url, anchor`,
    [
      docs.map((d) => d.source),
      docs.map((d) => d.url),
      docs.map((d) => d.anchor),
      docs.map((d) => d.title),
      docs.map((d) => encodePath(d.headingPath)),
      docs.map((d) => d.sectionTitle),
      docs.map((d) => d.version),
      docs.map((d) => d.contentHash),
    ],
  );

  stats.documentsUpserted += docRows.length;

  const idFor = new Map(docRows.map((r) => [`${r.source}\u0000${r.url}\u0000${r.anchor}`, r.id]));
  const resolved = docs.flatMap((doc) => {
    const id = idFor.get(`${doc.source}\u0000${doc.url}\u0000${doc.anchor}`);
    return id ? [{ id, doc }] : [];
  });
  if (resolved.length === 0) return;

  const documentIds = resolved.map((r) => r.id);

  // 2. Read current hashes for those documents in one statement.
  const { rows: existingRows } = await client.query<{
    document_id: string;
    ordinal: number;
    content_hash: string;
  }>(
    "SELECT document_id, ordinal, content_hash FROM chunks WHERE document_id = ANY($1::bigint[])",
    [documentIds],
  );
  const existingByKey = new Map(
    existingRows.map((r) => [`${r.document_id}:${r.ordinal}`, r.content_hash]),
  );

  // 3. Work out which chunks actually changed.
  const stale: {
    documentId: string;
    source: SourceId;
    ordinal: number;
    headingPath: string[];
    text: string;
    tokenEstimate: number;
    contentHash: string;
    existed: boolean;
  }[] = [];

  for (const { id, doc } of resolved) {
    for (const chunk of doc.chunks) {
      const key = `${id}:${chunk.ordinal}`;
      const current = existingByKey.get(key);
      if (current === chunk.contentHash) continue;
      stale.push({
        documentId: id,
        source: doc.source,
        ordinal: chunk.ordinal,
        headingPath: chunk.headingPath,
        text: chunk.text,
        tokenEstimate: chunk.tokenEstimate,
        contentHash: chunk.contentHash,
        existed: current !== undefined,
      });
    }
  }

  // 4. Embed only the changed chunks, in batches.
  if (stale.length > 0) {
    const EMBED_BATCH = 64;
    for (let i = 0; i < stale.length; i += EMBED_BATCH) {
      const slice = stale.slice(i, i + EMBED_BATCH);
      const vectors = await embedBatch(slice.map((c) => c.text));
      stats.embeddingsComputed += vectors.length;

      // 5. One set-based insert per batch.
      await client.query(
        `INSERT INTO chunks
           (document_id, source, ordinal, heading_path, text, char_count, token_estimate, content_hash, embedding)
         SELECT c.document_id, c.source, c.ordinal,
                CASE WHEN c.heading_path_enc = '' THEN '{}'::text[]
                     ELSE string_to_array(c.heading_path_enc, chr(31)) END,
                c.text, c.char_count, c.token_estimate, c.content_hash, c.embedding::vector
         FROM UNNEST(
           $1::bigint[], $2::text[], $3::int[], $4::text[],
           $5::text[], $6::int[], $7::int[], $8::text[], $9::text[]
         ) AS c(document_id, source, ordinal, heading_path_enc, text, char_count,
                token_estimate, content_hash, embedding)
         ON CONFLICT (document_id, ordinal) DO UPDATE SET
           heading_path   = EXCLUDED.heading_path,
           text           = EXCLUDED.text,
           char_count     = EXCLUDED.char_count,
           token_estimate = EXCLUDED.token_estimate,
           content_hash   = EXCLUDED.content_hash,
           embedding      = EXCLUDED.embedding`,
        [
          slice.map((c) => c.documentId),
          slice.map((c) => c.source),
          slice.map((c) => c.ordinal),
          slice.map((c) => encodePath(c.headingPath)),
          slice.map((c) => c.text),
          slice.map((c) => c.text.length),
          slice.map((c) => c.tokenEstimate),
          slice.map((c) => c.contentHash),
          vectors.map((v) => `[${v.join(",")}]`),
        ],
      );

      for (const c of slice) {
        if (c.existed) stats.chunksUpdated++;
        else stats.chunksInserted++;
      }
    }
  }

  // 6. Remove chunks that no longer exist because a section shrank.
  const keepPairs = resolved.flatMap((r) => r.doc.chunks.map((c) => [r.id, c.ordinal]));
  const deleted = await client.query(
    `DELETE FROM chunks ch
     WHERE ch.document_id = ANY($1::bigint[])
       AND NOT EXISTS (
         SELECT 1 FROM UNNEST($2::bigint[], $3::int[]) AS keep(document_id, ordinal)
         WHERE keep.document_id = ch.document_id AND keep.ordinal = ch.ordinal
       )`,
    [
      documentIds,
      keepPairs.map((p) => p[0]),
      keepPairs.map((p) => p[1]),
    ],
  );
  stats.chunksDeleted += deleted.rowCount ?? 0;
}

/**
 * Remove documents for a source that no longer appear upstream.
 *
 * Pruned by natural key `(url, anchor)`, not by URL alone. A section can
 * survive upstream while ceasing to produce any passages - FastAPI's
 * contributor list is now dropped at extraction as unmatchable, so the section
 * still exists as a heading but yields zero chunks. Pruning on the URL would
 * see that page as "seen" and keep the section, leaving its old chunks in the
 * index forever: never refreshed, never pruned, and still returned by queries.
 */
export async function pruneMissingDocuments(
  source: SourceId,
  seenKeys: Set<string>,
): Promise<number> {
  const rows = await query<{ id: string; url: string; anchor: string }>(
    "SELECT id, url, anchor FROM documents WHERE source = $1",
    [source],
  );
  const stale = rows.filter((r) => !seenKeys.has(documentKey(r.url, r.anchor)));
  if (stale.length === 0) return 0;
  const ids = stale.map((r) => r.id);
  await query("DELETE FROM documents WHERE id = ANY($1::bigint[])", [ids]);
  return ids.length;
}

/**
 * Natural key of a document row, matching how ingestion derives anchors.
 *
 * Shared by the ingest loop and the pruner so the two can never disagree about
 * which section is which - a mismatch would prune live sections or keep dead
 * ones, and neither failure announces itself.
 */
export function documentKey(url: string, anchor: string): string {
  return `${url}#${anchor}`;
}

export async function recordSourceVersion(source: SourceId, version: string): Promise<void> {
  await query(
    `UPDATE sources SET version = COALESCE($2, version) WHERE id = $1`,
    [source, version],
  );
}
