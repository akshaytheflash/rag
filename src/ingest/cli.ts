/**
 * Ingestion CLI.
 *
 *   npm run ingest                          all sources
 *   npm run ingest -- --source fastapi      one source
 *   npm run ingest -- --source python --source postgresql
 *   npm run ingest -- --limit 20            smoke test on a handful of pages
 *   npm run ingest -- --refresh             bypass the HTTP cache
 *   npm run ingest -- --target-tokens 400
 */
import { closePool } from "../lib/db";
import { ingestSource } from "./pipeline";
import { SOURCE_LIST, SOURCE_IDS, type SourceId } from "./sources";

interface Args {
  sources: SourceId[];
  limit?: number;
  refresh: boolean;
  targetTokens?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sources: [], refresh: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--source" || arg === "-s") {
      const value = argv[++i] as SourceId;
      if (!SOURCE_IDS.includes(value)) {
        throw new Error(`Unknown source "${value}". Valid: ${SOURCE_IDS.join(", ")}`);
      }
      args.sources.push(value);
    } else if (arg === "--limit" || arg === "-n") {
      args.limit = Number(argv[++i]);
    } else if (arg === "--refresh") {
      args.refresh = true;
    } else if (arg === "--target-tokens") {
      args.targetTokens = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run ingest -- [options]",
          "",
          "  -s, --source <id>       python | fastapi | postgresql (repeatable)",
          "  -n, --limit <n>         only process the first n pages (smoke test)",
          "      --refresh           ignore the local HTTP cache",
          "      --target-tokens <n> chunk size target (default 320)",
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  if (args.sources.length === 0) args.sources = [...SOURCE_IDS];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (message: string) => console.log(message);

  console.log("Documentation ingestion");
  console.log("Retrieval only - passages are copied verbatim, never summarised.\n");

  const totals = { pages: 0, chunks: 0, embedded: 0, failed: 0 };

  for (const id of args.sources) {
    const config = SOURCE_LIST.find((s) => s.id === id)!;
    console.log(`\n=== ${config.label} ${"=".repeat(50 - config.label.length)}`);

    const report = await ingestSource(config, {
      refresh: args.refresh,
      limit: args.limit,
      chunk: args.targetTokens ? { targetTokens: args.targetTokens } : undefined,
      log,
    });

    totals.pages += report.pagesFetched;
    totals.chunks += report.chunksInserted + report.chunksUpdated;
    totals.embedded += report.embeddingsComputed;
    totals.failed += report.pagesFailed;

    console.log(
      `\n  ${report.pagesFetched} pages, ${report.documentsUpserted} sections, ` +
        `${report.chunksInserted} new / ${report.chunksUpdated} updated / ${report.chunksDeleted} removed` +
        (report.version ? `, docs version ${report.version}` : ""),
    );
    console.log(`  ${(report.durationMs / 1000).toFixed(1)}s, ${report.pagesFailed} page failures`);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Total: ${totals.pages} pages, ${totals.chunks} passages written, ` +
      `${totals.embedded} embeddings computed, ${totals.failed} failures`,
  );

  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

