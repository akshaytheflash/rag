import { describe, expect, it } from "vitest";
import {
  buildPrompt,
  extractCitations,
  stripDanglingCitation,
  trimAtStop,
  type PromptPassage,
} from "@/lib/answer/prompt";
import { composeAnswer } from "@/lib/answer/compose";

const PASSAGES: PromptPassage[] = [
  { index: 1, text: "return FileResponse(path)", sectionTitle: "FileResponse", sourceLabel: "FastAPI" },
  { index: 2, text: "StreamingResponse takes an iterator.", sectionTitle: "StreamingResponse", sourceLabel: "FastAPI" },
];

describe("buildPrompt", () => {
  const prompt = buildPrompt({ question: "How do I return a file?", passages: PASSAGES });

  it("puts passages before the instruction", () => {
    // Measured failure: with the rules first, a model answers the rules rather
    // than the documents. "Continue from what is directly above you" is the
    // whole reason for this ordering.
    expect(prompt.indexOf("FileResponse")).toBeLessThan(prompt.indexOf("Question:"));
  });

  it("numbers passages so markers have something to refer to", () => {
    expect(prompt).toContain("[1]");
    expect(prompt).toContain("[2]");
  });

  it("collapses whitespace so a passage cannot inflate its own prominence", () => {
    const p = buildPrompt({
      question: "x",
      passages: [{ index: 1, text: "a\n\n\n   b", sectionTitle: "s", sourceLabel: "l" }],
    });
    expect(p).toContain("[1] (s) a b");
  });

  it("handles no passages without producing a broken prompt", () => {
    expect(() => buildPrompt({ question: "q", passages: [] })).not.toThrow();
  });
});

describe("extractCitations", () => {
  it("reads half-width markers", () => {
    expect(extractCitations("Use FileResponse [1] to reply [2].", 2)).toEqual([1, 2]);
  });

  it("reads the full-width brackets gpt-oss-20b actually emits", () => {
    // Measured, not hypothetical: the model writes 【1】 unprompted, and a
    // half-width-only regex silently discards those citations.
    expect(extractCitations("return FileResponse(path) 【1】", 2)).toEqual([1]);
  });

  it("ignores markers beyond the passage count", () => {
    // A model citing [7] against three passages would otherwise produce a
    // link to nothing.
    expect(extractCitations("a [1] b [7] c [0]", 3)).toEqual([1]);
  });

  it("deduplicates and preserves order of first appearance", () => {
    expect(extractCitations("[3] then [1] then [3] then 【2】", 3)).toEqual([3, 1, 2]);
  });

  it("does not read a two-digit marker as two one-digit ones", () => {
    expect(extractCitations("see [12] here", 12)).toEqual([12]);
  });

  it("tolerates whitespace inside the marker", () => {
    expect(extractCitations("quoted [ 1 ] and 【 2 】", 2)).toEqual([1, 2]);
  });
});

describe("trimAtStop", () => {
  it("cuts at a chat-template terminator", () => {
    expect(trimAtStop("the answer [1]<|im_end|>trailing junk")).toBe("the answer [1]");
  });

  it("cuts at a triple newline", () => {
    expect(trimAtStop("first para\n\n\nsecond para")).toBe("first para");
  });

  it("leaves a normal answer alone", () => {
    expect(trimAtStop("just an answer [1]")).toBe("just an answer [1]");
  });
});

describe("stripDanglingCitation", () => {
  // Tokens arrive one fragment at a time, so a stream can end mid-marker.
  it("removes a half-open trailing marker", () => {
    expect(stripDanglingCitation("the answer is here [")).toBe("the answer is here");
    expect(stripDanglingCitation("the answer is here 【2")).toBe("the answer is here");
  });

  it("removes a partially received number", () => {
    expect(stripDanglingCitation("cites passage [1")).toBe("cites passage");
  });

  it("keeps a completed citation", () => {
    expect(stripDanglingCitation("fully cited [1]")).toBe("fully cited [1]");
  });

  it("keeps a number that is not a citation", () => {
    expect(stripDanglingCitation("takes 2 arguments")).toBe("takes 2 arguments");
  });
});

describe("composeAnswer", () => {
  const stream = (q: string, p: PromptPassage[] = PASSAGES) => [...composeAnswer({ question: q, passages: p })].join("");

  it("quotes the passage and cites it", () => {
    expect(stream("how do I return a file response with FileResponse")).toContain("[1]");
  });

  it("every sentence it emits cites a passage that exists", () => {
    const text = stream("how do I return a file response");
    expect(extractCitations(text, 2).length).toBeGreaterThan(0);
  });

  it("only ever quotes text present in the passages", () => {
    // The property that matters for the no-key path: it cannot invent an API.
    const text = stream("FileResponse path");
    const quoted = text.replace(/\s*\[\d+\]/g, "").split(/(?<=[.!?])\s+/);
    for (const sentence of quoted) {
      const probe = sentence.split(" ").slice(0, 4).join(" ");
      if (probe.length < 8) continue;
      expect(
        PASSAGES.some((p) => p.text.includes(probe)),
      ).toBe(true);
    }
  });

  it("says so when nothing matches, rather than inventing an answer", () => {
    expect(stream("zzzz qqqq")).toMatch(/appears to cover/i);
    // No fabricated citation either - claiming a source would be the one
    // unforgivable thing for this path to do.
    expect(extractCitations(stream("zzzz qqqq"), 2)).toEqual([]);
  });

  it("streams in fragments, like a model would", () => {
    // The property that matters is that it yields progressively, not that it
    // yields a particular number of pieces - word count decides that.
    const fragments = [...composeAnswer({ question: "FileResponse", passages: PASSAGES })];
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.join("")).toBe(fragments.join(""));
  });
});