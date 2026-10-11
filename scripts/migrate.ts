/**
 * Applies every db/migrations/*.sql file in order, once each.
 *
 *   npm run db:migrate
 *
 * Must run against the DIRECT connection string: PgBouncer in transaction
 * mode cannot execute CREATE EXTENSION.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { withDirectConnection } from "../src/lib/db";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "db", "migrations");

async function main() {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.error("No migrations found.");
    process.exit(1);
  }

  await withDirectConnection(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex").slice(0, 16);
      const previous = applied.get(file);

      if (previous === checksum) {
        console.log(`  skip    ${file} (already applied)`);
        continue;
      }
      if (previous && previous !== checksum) {
        console.log(`  reapply ${file} (checksum changed)`);
      }

      process.stdout.write(`  apply   ${file} ... `);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          `INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)
           ON CONFLICT (name) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now()`,
          [file, checksum],
        );
        await client.query("COMMIT");
        console.log("ok");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.log("FAILED");
        throw err;
      }
    }
  });

  console.log("\nSchema up to date.");
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nMigration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
