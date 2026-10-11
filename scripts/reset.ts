/**
 * Empties the retrieval index so it can be rebuilt from scratch.
 *
 *   npm run db:reset
 *
 * Prefer `npm run ingest` for an update: it is incremental and only re-embeds
 * what actually changed. Reset is for when the chunking rules or the embedding
 * model have changed and the stored passages no longer match what the pipeline
 * would produce today.
 *
 * Deliberately does NOT drop the schema: only the indexed content is removed.
 */
import { closePool, withTransaction } from "../src/lib/db";

async function main() {
  const confirmed = process.argv.includes("--yes") || process.argv.includes("-y");
  if (!confirmed) {
    console.error(
      "This deletes every indexed passage. Re-run with --yes if that is what you want.",
    );
    process.exit(1);
  }

  const removed = await withTransaction(async (client) => {
    // chunks are removed by the ON DELETE CASCADE on documents.
    const docs = await client.query("DELETE FROM documents");
    await client.query("UPDATE sources SET version = NULL");
    return docs.rowCount ?? 0;
  });

  console.log(`Removed ${removed} sections and all of their passages.`);
  console.log("Run `npm run ingest` to rebuild.");

  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(`Reset failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
