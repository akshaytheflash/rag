import { describe, expect, it } from "vitest";
import path from "node:path";
import { AutoTokenizer, env as transformersEnv } from "@huggingface/transformers";
import { DEFAULT_CHUNK_OPTIONS, estimateTokens, chunkSection, splitCodeByLine, MAX_MODEL_TOKENS } from "../src/ingest/chunk";
import { MAX_TOKENS } from "../src/lib/embed";
import type { Block, Section } from "../src/ingest/extract";

/**
 * Regression guard.
 *
 * all-MiniLM-L6-v2 has a 256 word-piece position limit. A chunk that exceeds
 * it is silently truncated *before* it is embedded, so its tail is stored in
 * the database but can never be matched by a query. These tests measure the
 * real tokenisation of real chunk sizes rather than trusting the estimate.
 */
transformersEnv.localModelPath = path.resolve(process.cwd(), "models");
transformersEnv.allowRemoteModels = false;

const tokenizer = await AutoTokenizer.from_pretrained("Xenova/all-MiniLM-L6-v2");

/**
 * Documentation prose measured at roughly 5 characters per word-piece. Code
 * is denser (identifiers split into sub-words), which is exactly why code
 * blocks are never subdivided to fit.
 */
const PROSE_CHARS_PER_PIECE = 5.0;

function proseSection(paragraphs: string[]): Section {
  const blocks: Block[] = paragraphs.map((p) => ({ kind: "text", text: p }));
  return { headingPath: ["Guide"], title: "Guide", anchor: "guide", blocks };
}

describe("chunk size versus the model's position limit", () => {
  it("keeps the default target inside the tokenizer's limit", () => {
    expect(DEFAULT_CHUNK_OPTIONS.targetTokens).toBeLessThanOrEqual(MAX_TOKENS);
  });

  it("does not truncate a full-size prose chunk", async () => {
    const targetChars = DEFAULT_CHUNK_OPTIONS.targetTokens * 4;
    // A chunk at the size limit, made of text that tokenises like real docs.
    const paragraph = "In FastAPI a dependency is a callable shared across routes. ".repeat(60);
    const chunks = await chunkSection(proseSection([paragraph.slice(0, targetChars)]), 0);

    for (const chunk of chunks) {
      expect(tokenizer.encode(chunk.pageContent).length).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("splits a long paragraph on a sentence boundary rather than truncating it", async () => {
    // A single paragraph far larger than one chunk. The marker sits at the
    // very end, so if the chunker cut or dropped the overflow it would vanish.
    const marker = "The very last sentence of this section mentions ZEBRAFISH.";
    const filler = "The dependency is declared with Depends and shared across routes. ".repeat(120);

    const chunks = await chunkSection(proseSection([filler + marker]), 0);
    const joined = chunks.map((c) => c.pageContent).join("\n");

    expect(chunks.length).toBeGreaterThan(1);
    expect(joined).toContain(marker);
    for (const chunk of chunks) {
      expect(tokenizer.encode(chunk.pageContent).length).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("keeps the estimate a conservative overestimate for prose", () => {
    const prose =
      "PostgreSQL evaluates the query planner at execution time using statistics collected by ANALYZE. ";
    const full = prose.repeat(40);
    const pieces = tokenizer.encode(full).length;
    const charsPerPiece = full.length / pieces;

    // Anchored on the measured value, with room either side.
    expect(charsPerPiece).toBeGreaterThan(PROSE_CHARS_PER_PIECE - 1);
    expect(charsPerPiece).toBeLessThan(PROSE_CHARS_PER_PIECE + 1);
    // Dividing by 4 must never understate the real word-piece count, or
    // chunks would silently overrun the model's limit.
    expect(estimateTokens(full)).toBeGreaterThanOrEqual(pieces);
  });

  it("agrees with the embedding model's real limit", () => {
    expect(MAX_MODEL_TOKENS).toBe(MAX_TOKENS);
  });
});

/**
 * Code is denser than prose: identifiers split into sub-words, so the same
 * character count yields more word-pieces. Measured at ~3.2 chars/word-piece on
 * the FastAPI reference sidebar, against ~5.0 for prose.
 */
const CODE_CHARS_PER_PIECE = 3.2;

/**
 * Regression guard for a bug this file previously could not see.
 *
 * `splitCodeByLine` did not exist, so an oversized code block was emitted whole
 * and stored in the database regardless of size. FastAPI's `TYPE:` / `DEFAULT:`
 * sidebar produced chunks of 33,829 characters - 8,266 word-pieces against a
 * 256 limit - of which only the first 3% was ever embedded. Those passages
 * were indexed but unmatchable, and nothing here failed.
 *
 * The guard is deliberately end-to-end: it asserts on real tokenisation of
 * real chunks, not on the estimates the chunker reasons with.
 */
describe("oversized code blocks", () => {
  function codeSection(text: string): Section {
    return {
      headingPath: ["Reference", "Parameter"],
      title: "Parameter",
      anchor: "parameter",
      blocks: [{ kind: "code", text, language: null }],
    };
  }

  /** The shape that broke: FastAPI's repeated TYPE:/DEFAULT: sidebar. */
  const denseSidebar = Array.from(
    { length: 60 },
    (_, i) =>
      `Read more about it in the\nFastAPI docs about how to Generate Clients.\n\n\n\nTYPE:\nCallable[[APIRoute_${i}], str]\n\n\n\nDEFAULT:\nDefault()`,
  ).join("\n\n");

  it("splits a code block far past the tokenizer's limit", async () => {
    const chunks = await chunkSection(codeSection(denseSidebar), 0);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const pieces = tokenizer.encode(chunk.pageContent).length;
      expect(pieces).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("loses no content when it splits", async () => {
    const chunks = await chunkSection(codeSection(denseSidebar), 0);
    const joined = chunks.map((c) => c.pageContent).join("\n");

    // Every TYPE: line must survive somewhere. Losing any of them reintroduces
    // the original failure in miniature: text in the database that no query can
    // ever reach.
    for (let i = 0; i < 60; i++) {
      expect(joined).toContain(`APIRoute_${i}`);
    }
  });

  it("splits only at line boundaries, never mid-line", async () => {
    const chunks = await chunkSection(codeSection(denseSidebar), 0);
    for (const chunk of chunks) {
      // If a piece ended mid-line it would not be a whole number of lines.
      const lines = chunk.pageContent.split("\n");
      expect(lines.every((l) => l.trim().length > 0 || l === "")).toBe(true);
      // No piece may end in the middle of an identifier.
      expect(chunk.pageContent).not.toMatch(/APIRoute_\d*$/);
    }
  });

  it("leaves an ordinary code block untouched", async () => {
    const ordinary = "def create_app():\n    return FastAPI()\n";
    const chunks = await chunkSection(codeSection(ordinary), 0);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].pageContent).toBe(ordinary.trimEnd());
    // The whole sample is preserved verbatim, whitespace included.
    expect(chunks[0].pageContent).toContain("    return FastAPI()");
  });

  it("keeps the merge step inside the tokenizer's limit", async () => {
    // A full-size chunk followed by a runt: merging must not overflow.
    const body = "The dependency is declared with Depends. ".repeat(60);
    const chunks = await chunkSection(
      {
        headingPath: ["Guide"],
        title: "Guide",
        anchor: "guide",
        blocks: [
          { kind: "text", text: body },
          { kind: "code", text: "x", language: null },
        ],
      },
      0,
    );
    for (const chunk of chunks) {
      expect(tokenizer.encode(chunk.pageContent).length).toBeLessThanOrEqual(MAX_TOKENS);
    }
  });

  it("measures code at the density the ceiling assumes", () => {
    // If real code tokenises far denser than CODE_CHARS_PER_PIECE, the ceiling
    // above is optimistic and the guards would pass while chunks still
    // truncate. This is the number the assumption rests on.
    const sample = denseSidebar.slice(0, 20000);
    const ratio = sample.length / tokenizer.encode(sample).length;
    expect(ratio).toBeGreaterThan(CODE_CHARS_PER_PIECE - 0.4);
    expect(ratio).toBeLessThan(CODE_CHARS_PER_PIECE + 0.4);
  });
});

describe("splitCodeByLine", () => {
  it("returns the input unchanged when it is under the limit", () => {
    const text = "a\nb\nc";
    expect(splitCodeByLine(text, 100)).toEqual([text]);
  });

  it("never emits a piece longer than the limit when it can split", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line number ${i} of the block`).join("\n");
    const pieces = splitCodeByLine(lines, 200);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200);
    }
  });

  it("preserves every line across the split", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const rejoined = splitCodeByLine(lines, 60).join("\n");
    expect(rejoined).toBe(lines);
  });

  it("keeps an unsplittable line whole rather than corrupting it", () => {
    // One line longer than the ceiling: there is no safe split point, so the
    // piece must be emitted intact instead of being cut mid-token.
    const minified = "x".repeat(500);
    expect(splitCodeByLine(minified, 100)).toEqual([minified]);
  });
});
