/**
 * The no-key fallback: an answer assembled from the passages themselves.
 *
 * Not a language model, and not pretending to be one. It selects the sentences
 * that overlap the question most and quotes them, each with its citation, so
 * the interface still works with no API key, no network and no cost.
 *
 * The property that matters is that it cannot be wrong about the documentation:
 * every sentence it emits is one that is in the database, verbatim. A weaker
 * answer than a model would give, and a more reliable one.
 */
import type { PromptInput } from "./prompt";

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "to", "in", "on",
  "for", "with", "as", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "do", "does", "did", "how", "what", "when", "where", "which", "who", "why",
  "can", "could", "should", "would", "will", "i", "you", "it", "this", "that", "these",
  "those", "there", "here", "use", "using", "used", "get", "got", "make", "made",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Split into sentences without breaking the common code abbreviations. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z`"'(])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

/**
 * Score sentences by how much vocabulary they share with the question, and
 * emit the best ones in document order.
 *
 * Scoring is deliberately plain term overlap. Anything smarter would be a
 * worse version of the embedding model that already ranked these passages.
 */
function rankSentences(question: string, passages: PromptInput["passages"]) {
  const query = new Set(contentWords(question));
  if (query.size === 0) return [];

  const scored: { score: number; order: number; index: number; text: string }[] = [];
  let order = 0;

  for (const passage of passages) {
    for (const sentence of sentences(passage.text)) {
      const words = contentWords(sentence);
      if (words.length === 0) continue;

      let hits = 0;
      for (const word of words) if (query.has(word)) hits++;

      // Fraction of the sentence's vocabulary that the question asked for,
      // normalised by length so a long passage cannot win on volume alone.
      const score = hits / Math.sqrt(words.length);
      if (hits > 0) scored.push({ score, order: order++, index: passage.index, text: sentence });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/** Cap so the answer reads as an answer rather than a dump. */
const MAX_SENTENCES = 4;
const MAX_CHARS = 700;

/**
 * Compose an answer, yielded one fragment at a time.
 *
 * Yielded rather than returned so it streams through exactly the same code path
 * as a model: the interface has no idea whether the text came from a 27B model or
 * from a ranking function, which is what keeps the fallback invisible until it
 * has to be announced.
 */
export function* composeAnswer(prompt: PromptInput): Generator<string> {
  const ranked = rankSentences(prompt.question, prompt.passages);

  if (ranked.length === 0) {
    yield "None of the indexed documentation appears to cover this. Try different wording, or search all three manuals.";
    return;
  }

  // Keep the top sentences, but emit them in the order they appear in the
  // documentation so the answer reads sequentially rather than as a ranking.
  const top = ranked.slice(0, MAX_SENTENCES).sort((a, b) => a.order - b.order);

  let text = "";
  for (const sentence of top) {
    const piece = `${sentence.text} [${sentence.index}]`;
    if (text.length + piece.length > MAX_CHARS && text) break;
    text += (text ? " " : "") + piece;
  }

  // Word by word, so this streams at the same cadence a model does rather than
  // appearing in one lump.
  const words = text.split(/(\s+)/);
  for (const chunk of words) {
    if (chunk) yield chunk;
  }
}