/**
 * Ingestion pipeline.
 *
 * Runs locally only - never inside a Vercel function. It is the part of the
 * system that is allowed to be slow, use CPU for embedding, and talk to
 * third-party documentation hosts.
 */
import { getPool } from "../lib/db";
import { embed } from "../lib/embed";
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from "./chunk";
import { discoverPages } from "./discover";
import { extractPage, type Section } from "./extract";
import { fetchHtml, mapWithConcurrency, USER_AGENT } from "./http";
import {
  persistDocuments,
  prepareDocument,
  pruneMissingDocuments,
  recordSourceVersion,
  type PersistStats,
  type PreparedDocument,
} from "./store";
import type { SourceConfig, SourceId } from "./sources";

export interface IngestOptions {
  refresh?: boolean;
  limit?: number;
  chunk?: Partial<ChunkOptions>;
  log?: (message: string) => void;
}

export interface IngestReport extends PersistStats {
  source: SourceId;
  pagesDiscovered: number;
  pagesFetched: number;
  pagesSkipped: number;
  pagesFailed: number;
  version: string | null;
  durationMs: number;
}

const humanBytes = (n: number) => `${(n / 1024).toFixed(0)} KB`;

export async function ingestSource(
  config: SourceConfig,
  options: IngestOptions = {},
): Promise<IngestReport> {
  const log = options.log ?? (() => {});
  const started = Date.now();
  const chunkOptions: ChunkOptions = { ...DEFAULT_CHUNK_OPTIONS, ...options.chunk };

  const stats: PersistStats = {
    documentsUpserted: 0,
    chunksInserted: 0,
    chunksUpdated: 0,
    chunksDeleted: 0,
    embeddingsComputed: 0,
  };

  log(`${config.label}: discovering pages...`);
  let urls = await discoverPages(config);
  if (options.limit) urls = urls.slice(0, options.limit);

  const report: IngestReport = {
    ...stats,
    source: config.id,
    pagesDiscovered: urls.length,
    pagesFetched: 0,
    pagesSkipped: 0,
    pagesFailed: 0,
    version: null,
    durationMs: 0,
  };

  if (urls.length === 0) {
    report.durationMs = Date.now() - started;
    return report;
  }

  log(`${config.label}: ${urls.length} pages (concurrency ${config.crawl.concurrency})`);

  const pool = getPool();

  let done = 0;
  const ticker = setInterval(() => {
    log(
      `  ${done}/${urls.length} pages | ${stats.chunksInserted} new, ` +
        `${stats.chunksUpdated} updated, ${stats.documentsUpserted} sections`,
    );
  }, 5000);
  ticker.unref?.();

  const results = await mapWithConcurrency(urls, config.crawl.concurrency, async (url) => {
    const response = await fetchHtml(url, {
      refresh: options.refresh,
      delayMs: config.crawl.delayMs,
    });
    const page = extractPage(response.body, url, config);
    done++;
    return page;
  });

  clearInterval(ticker);

  const prepared: PreparedDocument[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      report.pagesFailed++;
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      log(`  ! failed: ${message}`);
      continue;
    }

    const page = result.value;
    report.pagesFetched++;
    if (page.version && !report.version) report.version = page.version;

    const sections: Section[] = page.sections;
    if (sections.length === 0) {
      report.pagesSkipped++;
      continue;
    }

    // One document row per section keeps citations precise. Sections that
    // share a heading on the same page are numbered so their natural keys
    // stay distinct.
    const anchorSeen = new Map<string, number>();
    for (const section of sections) {
      const base = section.anchor || section.headingPath.join(" / ");
      const occurrence = anchorSeen.get(base) ?? 0;
      anchorSeen.set(base, occurrence + 1);

      const doc = prepareDocument(config.id, page, section, chunkOptions, occurrence);
      if (doc.chunks.length > 0) prepared.push(doc);
    }
  }

  log(`${config.label}: embedding and storing ${prepared.length} sections...`);

  const client = await pool.connect();
  try {
    // One transaction per batch keeps round trips low; Neon is far from here.
    const BATCH = 100;
    for (let i = 0; i < prepared.length; i += BATCH) {
      const batch = prepared.slice(i, i + BATCH);
      await client.query("BEGIN");
      try {
        await persistDocuments(client, batch, (texts) => embed(texts), stats);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      }
    }
  } finally {
    client.release();
  }

  // Only prune on a complete pass. With --limit we have deliberately not
  // looked at most of the source, so treating the unseen pages as deleted
  // would wipe the index during a smoke test.
  if (!options.limit) {
    const seenUrls = new Set(
      results.flatMap((r) => (r.status === "fulfilled" ? [r.value.canonicalUrl] : [])),
    );
    const pruned = await pruneMissingDocuments(config.id, seenUrls);
    if (pruned > 0) log(`  removed ${pruned} sections that no longer exist upstream`);
  }

  if (report.version) await recordSourceVersion(config.id, report.version);

  report.durationMs = Date.now() - started;
  Object.assign(report, stats);
  return report;
}

export { USER_AGENT, humanBytes };
