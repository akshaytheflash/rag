import { describe, expect, it } from "vitest";
import { chunkPage, chunkSection, DEFAULT_CHUNK_OPTIONS, estimateTokens } from "../src/ingest/chunk";
import type { Block, Section } from "../src/ingest/extract";

function text(s: string): Block {
  return { kind: "text", text: s };
}
function code(s: string): Block {
  return { kind: "code", text: s, language: "python" };
}

function section(blocks: Block[], headingPath: string[] = ["Guide", "A section"]): Section {
  return { headingPath, title: headingPath[headingPath.length - 1], anchor: "a-section", blocks };
}

describe("estimateTokens", () => {
  it("scales with length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });
});

describe("chunkSection", () => {
  it("keeps short sections as a single chunk", () => {
    const chunks = chunkSection(section([text("A short paragraph about dependencies.")]), 0);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].ordinal).toBe(0);
    expect(chunks[0].headingPath).toEqual(["Guide", "A section"]);
  });

  it("never splits a code block across chunks", () => {
    const long = Array.from({ length: 200 }, (_, i) => `    step_${i} = compute(${i})`).join("\n");
    const chunks = chunkSection(section([code(long)]), 0);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(long);
  });

  it("keeps code intact when it sits inside surrounding prose", () => {
    const snippet = "from typing import Annotated\n\n\ndef common(q: str | None = None):\n    if q:\n        return q\n    return q";
    const chunks = chunkSection(
      section([text("Intro."), code(snippet), text("Outro.")]),
      0,
    );

    const joined = chunks.map((c) => c.text).join("\n");
    expect(joined).toContain("def common(q: str | None = None):");
    expect(joined).toContain("    if q:");
    // Every line of the snippet survives intact somewhere in the output.
    for (const line of snippet.split("\n")) {
      expect(joined.split("\n")).toContain(line);
    }
  });

  it("emits an oversized code block on its own rather than cutting it", () => {
    const huge = "x".repeat(DEFAULT_CHUNK_OPTIONS.targetTokens * 4 * 3);
    const chunks = chunkSection(section([text("lead in"), code(huge)]), 0);

    expect(chunks).toHaveLength(2);
    expect(chunks.some((c) => c.text === huge)).toBe(true);
  });

  it("numbers ordinals densely and in order", () => {
    const chunks = chunkSection(
      section([
        text("one ".repeat(400)),
        text("two ".repeat(400)),
        text("three ".repeat(400)),
        text("four ".repeat(400)),
      ]),
      0,
    );

    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk, i) => expect(chunk.ordinal).toBe(i));
  });

  it("does not emit a runt trailing chunk", () => {
    // A full chunk followed by a couple of leftover words.
    const chunks = chunkSection(
      section([text("filler ".repeat(1500)), text("end.")]),
      0,
      { ...DEFAULT_CHUNK_OPTIONS, targetTokens: 200 },
    );

    const last = chunks[chunks.length - 1];
    expect(last.tokenEstimate).toBeGreaterThanOrEqual(DEFAULT_CHUNK_OPTIONS.minTokens);
  });

  it("carries the heading path onto every chunk so results can be cited", () => {
    const chunks = chunkSection(
      section([text("a ".repeat(2000)), text("b ".repeat(2000))], ["Tutorial", "Dependencies"]),
      0,
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.headingPath).toEqual(["Tutorial", "Dependencies"]);
    }
  });
});

describe("chunkPage", () => {
  it("numbers continuously across sections", () => {
    const page: Section[] = [
      { headingPath: ["A"], title: "A", anchor: "a", blocks: [text("alpha " .repeat(300))] },
      { headingPath: ["B"], title: "B", anchor: "b", blocks: [text("beta " .repeat(300))] },
      { headingPath: ["C"], title: "C", anchor: "c", blocks: [text("gamma " .repeat(300))] },
    ];

    const chunks = chunkPage(page);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    chunks.forEach((chunk, i) => expect(chunk.ordinal).toBe(i));
  });

  it("returns nothing for a page with no sections", () => {
    expect(chunkPage([])).toEqual([]);
  });
});
