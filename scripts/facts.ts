/**
 * Measures the real numbers the implementation page renders.
 *
 *   npm run db:stats -- --facts
 *
 * Every figure on that page comes from here rather than from prose, so the page
 * cannot drift from the system it describes. Re-run it after a re-ingest.
 */
import { closePool, query } from "../src/lib/db";
import { embedOne, toVectorLiteral } from "../src/lib/embed";

/** Questions a user would plausibly type, paired with the manual they need. */
const RELEVANT: [string, "all" | "python" | "fastapi" | "postgresql"][] = [
  ["How do I create a dependency in FastAPI?", "fastapi"],
  ["What is a generator function in Python?", "python"],
  ["How do I build an index on a PostgreSQL table?", "postgresql"],
  ["How do I use a window function with OVER?", "postgresql"],
  ["How do I read a file in Python?", "python"],
  ["How do I write an async function with await?", "python"],
  ["How do I serve a static file in FastAPI?", "fastapi"],
  ["What are database constraints in PostgreSQL?", "postgresql"],
  ["How do I use try and except to handle errors?", "python"],
  ["How do I define a Pydantic model for a request body?", "fastapi"],
];

/** Questions with no answer in these manuals. The upper bound they reach is
 *  what the relevance threshold has to stay above. */
const OFF_TOPIC = [
  "What is the capital of France?",
  "How do I bake sourdough bread at home?",
  "What is the difference between waffle batter and astrophysics?",
  "How do I change the oil in a car engine?",
  "Who won the 1998 World Cup final?",
];

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

async function main() {
  const out: Record<string, unknown> = {};

  const corpus = await query(`
    SELECT source, count(*)::int passages,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY char_count)::int median_chars,
           max(char_count)::int max_chars
    FROM chunks GROUP BY source ORDER BY source`);
  out.corpus = corpus;

  const sizes = await query(`
    SELECT relname, pg_total_relation_size(relid) bytes, n_live_tup
    FROM pg_stat_user_tables WHERE relname IN ('chunks','documents') ORDER BY bytes DESC`);
  out.sizes = sizes;

  const indexes = await query(`
    SELECT indexrelname AS name, pg_relation_size(indexrelid) bytes
    FROM pg_stat_user_indexes WHERE relname = 'chunks' ORDER BY bytes DESC`);
  out.indexes = indexes;

  const db = await query(`SELECT pg_database_size(current_database()) AS bytes`);
  out.database = db[0];

  // Score separation: the evidence behind the threshold.
  const relevant: number[] = [];
  for (const [q] of RELEVANT) {
    const v = toVectorLiteral(await embedOne(q));
    const rows = await query(
      `SELECT 1 - (embedding <=> $1::vector) AS sim FROM chunks
       ORDER BY embedding <=> $1::vector LIMIT 25`, [v]);
    relevant.push(...rows.map((r) => Number(r.sim)));
  }

  const offTopic: number[] = [];
  for (const q of OFF_TOPIC) {
    const v = toVectorLiteral(await embedOne(q));
    const rows = await query(
      `SELECT 1 - (embedding <=> $1::vector) AS sim FROM chunks
       ORDER BY embedding <=> $1::vector LIMIT 25`, [v]);
    offTopic.push(...rows.slice(0, 5).map((r) => Number(r.sim)));
  }

  out.scoreSeparation = {
    relevant: {
      min: Math.min(...relevant),
      p05: pct(relevant, 0.05),
      p25: pct(relevant, 0.25),
      median: pct(relevant, 0.5),
      p75: pct(relevant, 0.75),
      max: Math.max(...relevant),
      count: relevant.length,
    },
    offTopic: {
      max: Math.max(...offTopic),
      median: pct(offTopic, 0.5),
      p95: pct(offTopic, 0.95),
      count: offTopic.length,
    },
  };

  // What the threshold admits, swept.
  const sweep = [];
  for (const threshold of [0.25, 0.3, 0.35, 0.38, 0.45, 0.5, 0.55, 0.6]) {
    let keptRelevant = 0;
    for (const [q] of RELEVANT) {
      const v = toVectorLiteral(await embedOne(q));
      const rows = await query(
        `SELECT count(*)::int c FROM chunks WHERE (embedding <=> $1::vector) <= $2`,
        [v, 1 - threshold]);
      keptRelevant += rows[0].c;
    }
    let keptNoise = 0;
    for (const q of OFF_TOPIC) {
      const v = toVectorLiteral(await embedOne(q));
      const rows = await query(
        `SELECT count(*)::int c FROM chunks WHERE (embedding <=> $1::vector) <= $2`,
        [v, 1 - threshold]);
      keptNoise += rows[0].c;
    }
    sweep.push({
      threshold,
      relevantPerQuery: +(keptRelevant / RELEVANT.length).toFixed(1),
      offTopicPerQuery: +(keptNoise / OFF_TOPIC.length).toFixed(1),
    });
  }
  out.thresholdSweep = sweep;

  console.log(JSON.stringify(out, null, 2));
  await closePool();
}

main().catch((e) => { console.error(e); process.exit(1); });