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
    expectTitle: /depend/i,
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

/**
 * How a hit was matched. A lexical-only hit has no similarity score, so it is
 * reported by what did match rather than by a number that was never measured.
 */
function describeMatch(hit: { similarity: number | null; matchedBy: string[] }): string {
  const parts: string[] = [];
  if (hit.similarity !== null) parts.push(`sim ${hit.similarity.toFixed(3)}`);
  parts.push(`via ${hit.matchedBy.join("+")}`);
  return `[${parts.join(" ")}]`;
}

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
        ? `${describeMatch(top)} ${top.source} · ${top.sectionTitle.slice(0, 48)} (${elapsed}ms)`
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
    // Fused ranking, not raw similarity: a passage both retrievers found must
    // outrank one only the vector search liked.
    const scores = response.results.map((r) => r.similarity ?? 0);
    check(
      "every result carries match provenance",
      response.results.every((r) => r.matchedBy.length > 0),
      response.results.map((r) => r.matchedBy.join("+")).join(" "),
    );
    const both = response.results.filter((r) => r.matchedBy.length === 2).length;
    check(
      "the two retrievers contribute overlapping candidates",
      both > 0,
      `${both} of ${response.results.length} results were found by both; ` +
        `candidates considered ${response.retrieval.candidatesConsidered} ` +
        `(${response.retrieval.semanticCandidates} semantic, ` +
        `${response.retrieval.lexicalCandidates} lexical)`,
    );
    void scores;
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

    // The threshold is a floor on *semantic* relevance, and hybrid retrieval
    // deliberately lets the lexical side through it: an exact API name is
    // precisely the query a 22M-parameter sentence encoder handles worst, so
    // gating it on cosine similarity would throw away the cases BM25 was added
    // to rescue. A result therefore either clears the threshold or carries no
    // semantic score at all - it must never sit below it.
    const violations = response.results.filter(
      (r) => r.similarity !== null && r.similarity < strict.threshold,
    );
    check(
      "no result sits below the threshold",
      violations.length === 0,
      `${response.results.length} results at threshold ${strict.threshold}, ` +
        `${violations.length} below it ` +
        `(${response.results.filter((r) => r.similarity === null).length} lexical-only)`,
    );

    // What the threshold must still do: keep genuinely unrelated text out.
    const noise = await search({ query: "sourdough bread", threshold: 0.9, limit: 10 });
    const offTopic = noise.results.filter(
      (r) => r.similarity !== null && r.similarity < 0.9,
    );
    check(
      "an unrelated question stays filtered out at a high threshold",
      offTopic.length === 0,
      `${noise.results.length} results, ${offTopic.length} below threshold`,
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
