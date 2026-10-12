/**
 * Check that each demo question is answered directly by its top passage.
 *
 * The demo questions are the first thing anyone sees, so they carry a stricter
 * requirement than a passing search would: the single best passage must
 * actually answer the question, not merely be about it. A demo that opens on a
 * sidebar block or a neighbouring topic makes the whole index look worse than
 * it is.
 *
 * This runs the real pipeline - hybrid retrieval, then the answer generator -
 * and fails when the answer is not grounded in passage 1.
 *
 *   npm run eval:examples
 *
 * Re-run after any change to the index, the chunker, the threshold or the
 * generator. A demo question that stops being answered is a regression, and
 * this is what catches it.
 */
import { search } from "../src/lib/search";
import { streamWithFallback } from "../src/lib/answer/chain";
import { extractCitations, trimAtStop, stripDanglingCitation } from "../src/lib/answer/prompt";
import { closePool } from "../src/lib/db";

interface Example {
  question: string;
  /** null means the "all" filter. */
  source: "python" | "fastapi" | "postgresql" | null;
  /** Substring the top passage title must contain. */
  expectTitle: RegExp;
}

/**
 * Kept in step with EXAMPLES in src/components/DocSearchApp.tsx by hand,
 * because importing a client component's constant into a Node script drags in
 * React. The questions below are the same strings.
 */
const EXAMPLES: Example[] = [
  { question: "How do I use Depends to declare a dependency in FastAPI?", source: null, expectTitle: /Depends/i },
  { question: "How do I use Depends to declare a dependency in FastAPI?", source: "fastapi", expectTitle: /Depends/i },
  { question: "How do I use a WebSocket in FastAPI?", source: "fastapi", expectTitle: /websocket/i },
  { question: "How do I use TestClient to test a FastAPI app?", source: "fastapi", expectTitle: /test ?client/i },
  { question: "How do I create a virtual environment in Python?", source: "python", expectTitle: /virtual environment/i },
  { question: "How do I use a transaction with BEGIN and COMMIT in PostgreSQL?", source: "postgresql", expectTitle: /transaction/i },
];

/**
 * Section titles that are furniture in the PostgreSQL manual rather than
 * content. The manual splits asides into their own short passages, and being
 * short they score well on term overlap - so they surface as top hits for
 * questions they do not answer. A demo question must never land on one.
 */
const FURNITURE = /^(note|tip|warning|important|caution|compatibility|parameters|examples?|see also|references|parameters and settings)$/i;

let failures = 0;

for (const ex of EXAMPLES) {
  const source = ex.source ?? "all";
  const res = await search({ query: ex.question, source, limit: 6 });

  if (res.results.length === 0) {
    console.log(`  FAIL  [${source}] ${ex.question}\n          no passages at all`);
    failures++;
    continue;
  }

  const top = res.results[0];
  const titleOk = ex.expectTitle.test(top.sectionTitle);
  const notFurniture = !FURNITURE.test(top.sectionTitle);

  if (!titleOk || !notFurniture) {
    console.log(
      `  FAIL  [${source}] ${ex.question}\n` +
        `          top passage is "${top.sectionTitle}"` +
        (notFurniture ? " (title did not match the expected subject)" : " (sidebar furniture, not content)"),
    );
    failures++;
    continue;
  }

  // Now the harder half: does the answer actually come out of that passage?
  const passages = res.results.map((r, i) => ({
    index: i + 1,
    text: r.text,
    sectionTitle: r.sectionTitle,
    sourceLabel: r.sourceLabel,
  }));

  let raw = "";
  await streamWithFallback({ question: ex.question, passages }, (t) => {
    raw += t;
  });

  const answer = trimAtStop(stripDanglingCitation(raw));
  const cites = extractCitations(answer, passages.length);

  if (!cites.includes(1)) {
    console.log(
      `  FAIL  [${source}] ${ex.question}\n` +
        `          top passage "${top.sectionTitle}" (sim ${top.similarity?.toFixed(3)}) was not cited; cited [${cites.join(",") || "nothing"}]\n` +
        `          "${answer.replace(/\s+/g, " ").slice(0, 140)}"`,
    );
    failures++;
    continue;
  }

  console.log(
    `  pass  [${source}] ${ex.question}\n` +
      `          -> "${top.sectionTitle}" sim ${top.similarity?.toFixed(3)} via ${top.matchedBy.join("+")}, cited [${cites.join(",")}]`,
  );
}

await closePool();

console.log(
  failures === 0
    ? `\nAll ${EXAMPLES.length} demo questions answered directly from their top passage.`
    : `\n${failures} of ${EXAMPLES.length} demo questions are not answered by their top passage.`,
);

process.exit(failures === 0 ? 0 : 1);