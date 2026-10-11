import { describe, expect, it } from "vitest";
import path from "node:path";
import { AutoTokenizer, env as transformersEnv } from "@huggingface/transformers";
import { DEFAULT_CHUNK_OPTIONS, estimateTokens, chunkSection } from "../src/ingest/chunk";
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
});
