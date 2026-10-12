/**
 * The prompt, and the parsing of what comes back.
 *
 * Retrieval alone cannot answer a question - it returns passages and leaves the
 * synthesis to the reader. A language model can do that step, but only over the
 * passages it is given, and only if it is made to quote rather than compose.
 * Everything in this file exists to make that happen.
 *
 * The passages are the source of truth. Text produced from them is a reading
 * aid over the documentation, never a replacement for it, and the interface
 * says so.
 */

/** One passage as the model sees it. */
export interface PromptPassage {
  /** 1-based; matches the [n] marker the model is asked to emit. */
  index: number;
  text: string;
  sectionTitle: string;
  sourceLabel: string;
}

export interface PromptInput {
  question: string;
  passages: PromptPassage[];
}

export interface AnswerGenerator {
  /** Stable id, shown in the interface so the source of the text is never a mystery. */
  readonly id: string;
  /** Human-readable, e.g. "openai/gpt-oss-20b on Groq". */
  readonly label: string;
  /**
   * Stream an answer.
   *
   * Contract that the fallback chain depends on: throw *before* calling
   * onToken if the provider cannot serve this request at all. Once onToken has
   * fired, the text is already on screen and the chain must not switch -
   * splicing two answers together reads as a model contradicting itself.
   */
  stream(
    prompt: PromptInput,
    onToken: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

/**
 * Build the prompt.
 *
 * Two deliberate choices, each fixing an observed failure:
 *
 * Passages first, instruction last. A model continues from what sits immediately
 * above it. With a block of rules first, the local 135M model answered the
 * rules - "The answer is yes because..." to a question with nothing to do with
 * yes or no. Evidence placed directly before the instruction gives it
 * something to continue from.
 *
 * One instruction sentence. Every additional rule was tried and either did
 * nothing or displaced the evidence.
 */
export function buildPrompt({ question, passages }: PromptInput): string {
  const context = passages
    .map((p) => `[${p.index}] (${p.sectionTitle}) ${collapse(p.text)}`)
    .join("\n\n");

  return `Documents:

${context}

Using only the documents above, answer the question by copying sentences word for word rather than writing your own, and put the document number in square brackets after each copied sentence, like [1]. If the documents do not answer it, say so.

Question: ${question}

Answer:`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Citation markers in the wild.
 *
 * Half-width `[1]` is what the prompt asks for. Full-width `【1】` is what
 * gpt-oss-20b actually emitted in testing, unprompted - it is a CJK bracket
 * pair and a routine slip for a tokeniser that has seen both in its training
 * data. Both are accepted, because the alternative is discarding correct
 * citations the model did produce.
 *
 * Word-boundary guarded: `[1]` inside `[12]` must not match as 1, and
 * markdown links like `[text](url)` must not be read as citations at all.
 */
const CITATION_RE = /[\[【]\s?(\d{1,2})\s?[\]】]/g;

/**
 * Extract cited passage numbers, in order, deduplicated, range-checked.
 *
 * Range checking matters: a model that invents `[7]` when there are three
 * passages would otherwise produce a link to nothing.
 */
export function extractCitations(text: string, passageCount: number): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= passageCount && !found.includes(n)) found.push(n);
  }
  return found;
}

/**
 * Cut generation at the first stop marker.
 *
 * Applied to accumulated text so nothing downstream has to clean up. The
 * model does not reliably emit EOS on this task and will loop a phrase until it
 * hits the cap; a short answer that stops is worth more than a long one that
 * repeats itself.
 */
export function trimAtStop(text: string): string {
  let out = text;
  for (const stop of ["</s>", "<|im_end|>", "\n\n\n"]) {
    const i = out.indexOf(stop);
    if (i !== -1) out = out.slice(0, i);
  }
  return out.trim();
}

/**
 * Drop a trailing incomplete citation.
 *
 * Markers arrive a character at a time, so a stream can end mid-marker with
 * `[` on screen. Left alone it renders as a stray bracket for the rest of the
 * page's life. Only an unclosed *trailing* marker is removed - a closed
 * `[1]` earlier in the text is a real citation and stays.
 */
export function stripDanglingCitation(text: string): string {
  return text.replace(/[\[【]\s?\d{0,2}\s?$/, "").trimEnd();
}