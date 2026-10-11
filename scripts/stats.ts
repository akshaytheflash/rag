/**
 * Prints what is currently in the index.
 *
 *   npm run db:stats
 */
import { closePool } from "../src/lib/db";
import { getCorpusStats } from "../src/lib/search";

const pad = (value: string, width: number) => value.padEnd(width);
const num = (value: number) => value.toLocaleString("en-US");

async function main() {
  const { sources, totalPassages } = await getCorpusStats();

  console.log("\nCorpus");
  console.log("-".repeat(64));
  console.log(
    pad("  manual", 14) + pad("version", 12) + pad("sections", 12) + pad("passages", 12) + "characters",
  );

  for (const source of sources) {
    console.log(
      "  " +
        pad(source.name, 12) +
        pad(source.version ?? "-", 12) +
        pad(num(source.documents), 12) +
        pad(num(source.passages), 12) +
        num(source.characters),
    );
  }

  console.log("-".repeat(64));
  console.log(`  ${pad("total", 12)}${pad("", 12)}${pad("", 12)}${pad(num(totalPassages), 12)}`);
  console.log();

  await closePool();
  process.exit(0);
}

main().catch((err) => {
  console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
