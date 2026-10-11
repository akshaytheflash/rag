/**
 * End-to-end checks against the live index.
 *
 *   npm run verify
 *
 * Exercises the real query path: embed a question, run the same SQL the API
 * route runs, and assert what comes back. Unlike the unit tests this needs
 * DATABASE_URL and the embedding model, so it is a smoke test rather than part
 * of `npm test`.
 */
import { closePool } from "../src/lib/db";
import { search, resolveFilters, getCorpusStats, DEFAULT_THRESHOLD } from "../src/lib/search";

interface Case {
  question: string;
  /** A phrase the correct passage should contain, if we expect a hit. */
  expect?: RegExp;
  /** Section title fragment, when the expected answer is a specific page. */
  expectTitle?: RegExp;
  source?: "all" | "python" | "fastapi" | "postgresql";
  expectEmpty?: boolean;
}

const CASES: Case[] = [
  {
    question: "How do I create a dependency in FastAPI?",
    source: "fastapi",
    expectTitle: /Depends/i,
  },
  {
    question: "What is a generator function in Python?",
    source: "python",
    expectTitle: /generat/i,
  },
  {
    question: "How do I build an index on a PostgreSQL table?",
    source: "postgresql",
    expect: /CREATE\s+INDEX|create an index/i,
  },
  {
    question: "How do I use a window function with OVER?",
    source: "postgresql",
    expectTitle: /window/i,
  },
  {
    question: "How do I read a file in Python?",
    source: "python",
    expectTitle: /file/i,
  },
  {
    question: "How do I return a file response from a route in FastAPI?",
    source: "fastapi",
    expectTitle: /FileResponse|file/i,
  },
  {
    question: "What is the difference between waffle batter and astrophysics?",
    source: "all",
    expectEmpty: true,
  },
  {
    question: "How do I bake sourdough bread at home?",
    source: "all",
    expectEmpty: true,
  },
  {
    question: "What is the capital of France?",
    source: "all",
    expectEmpty: true,
  },
];

let failures = 0;

function check(name: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "pass" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log("\nCorpus");
  const { sources, totalPassages } = await getCorpusStats();
  for (const source of sources) {
    console.log(
      `  ${source.name.padEnd(12)} ${String(source.documents).padStart(6)} sections  ` +
        `${String(source.passages).padStart(7)} passages  ${source.version ?? "-"}`,
    );
  }
  console.log(`  ${"total".padEnd(12)} ${"".padStart(6)}          ${String(totalPassages).padStart(7)} passages\n`);

  if (totalPassages === 0) {
    console.error("The index is empty. Run `npm run ingest` first.");
    process.exit(1);
  }

  console.log(`\nSearch (threshold ${DEFAULT_THRESHOLD})`);
  for (const testCase of CASES) {
    const started = Date.now();
    const response = await search({
      query: testCase.question,
      source: testCase.source ?? "all",
      limit: 5,
      threshold: DEFAULT_THRESHOLD,
    });
    const elapsed = Date.now() - started;
    const top = response.results[0];

    if (testCase.expectEmpty) {
      check(
        testCase.question,
        response.results.length === 0,
        `${response.results.length} results, best ${response.bestScore?.toFixed(3) ?? "n/a"} (${elapsed}ms)`,
      );
      continue;
    }

    const matched =
      Boolean(top) &&
      (testCase.expectTitle ? testCase.expectTitle.test(top.sectionTitle) : true) &&
      (testCase.expect ? testCase.expect.test(top.text) : true);

    check(
      testCase.question,
      matched,
      top
        ? `${top.similarity.toFixed(3)} ${top.source} · ${top.sectionTitle.slice(0, 48)} (${elapsed}ms)`
        : `no results above threshold (${elapsed}ms)`,
    );

    if (top) {
      if (!/^https:\/\//.test(top.url)) {
        check(`  ${testCase.question.slice(0, 40)}... url`, false, `bad url: ${top.url}`);
      }
      if (top.text.trim().length < 20) {
        check(`  ${testCase.question.slice(0, 40)}... text`, false, "passage is empty");
      }
    }
  }

  console.log("\nSource filter");
  for (const source of ["python", "fastapi", "postgresql"] as const) {
    const response = await search({ query: "index", source, limit: 10, threshold: 0.2 });
    const leaked = response.results.filter((r) => r.source !== source);
    check(
      `filter ${source}`,
      leaked.length === 0,
      `${response.results.length} results, ${leaked.length} from other sources`,
    );
  }

  console.log("\nRanking");
  {
    const response = await search({
      query: "How do I create a dependency in FastAPI?",
      source: "fastapi",
      limit: 8,
      threshold: 0.2,
    });
    const scores = response.results.map((r) => r.similarity);
    const sorted = scores.every((s, i) => i === 0 || scores[i - 1] >= s);
    check("results are ordered by descending similarity", sorted, scores.map((s) => s.toFixed(2)).join(" "));
  }

  console.log("\nCitation integrity");
  {
    const response = await search({ query: "async def", source: "python", limit: 5, threshold: 0.3 });
    const bad = response.results.filter(
      (r) => !r.url.startsWith("https://docs.python.org/3/") || r.headingPath.length === 0,
    );
    check(
      "every python result has a docs.python.org URL and a heading path",
      bad.length === 0,
      `${response.results.length} checked, ${bad.length} bad`,
    );
  }

  console.log("\nThreshold");
  {
    const strict = resolveFilters({ threshold: 0.9 });
    const response = await search({ query: "index", threshold: strict.threshold, limit: 10 });
    const allAbove = response.results.every((r) => r.similarity >= strict.threshold);
    check(
      "an unreachable threshold returns nothing",
      response.results.length === 0 && allAbove,
      `${response.results.length} results at threshold ${strict.threshold}`,
    );
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
  await closePool();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
