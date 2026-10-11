/**
 * Word-piece counting.
 *
 * all-MiniLM-L6-v2 truncates at 256 word-pieces, and a chunk past that limit is
 * silently shortened before it is embedded - the tail is stored but can never
 * match a query. Deciding whether a chunk fits therefore needs the *real*
 * tokenizer, not a characters-per-word-piece estimate.
 *
 * The estimate was tried and was not good enough. Documentation prose measures
 * about 5.0 characters per word-piece, code about 3.2, PostgreSQL's operator
 * tables 1.33, and a FastAPI contributor list 1.86. Any single constant is
 * wrong for most of the corpus: sized for the densest content it splits prose
 * into unreadable fragments, sized for prose it truncates the dense cases.
 * Measured against the index, guessing at 3.2 left 32 chunks per 60 pages
 * truncated; guessing at 1.33 cut the FastAPI corpus from 2,803 chunks to
 * 11,702 by fragmenting perfectly good prose.
 *
 * The tokenizer is loaded from the same committed weights the embedder uses,
 * and costs one pass over text that is about to be embedded anyway.
 */
import path from "node:path";
import { AutoTokenizer, env as transformersEnv, type PreTrainedTokenizer } from "@huggingface/transformers";

let tokenizerPromise: Promise<PreTrainedTokenizer> | null = null;

/**
 * Lazily load the tokenizer.
 *
 * Kept out of module scope so importing this from the chunker does not make
 * every consumer - including unit tests that never embed - pay for it.
 */
export async function getTokenizer(): Promise<PreTrainedTokenizer> {
  if (!tokenizerPromise) {
    transformersEnv.localModelPath = path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      "models",
    );
    transformersEnv.allowRemoteModels = false;
    transformersEnv.allowLocalModels = true;
    tokenizerPromise = AutoTokenizer.from_pretrained("Xenova/all-MiniLM-L6-v2");
  }
  return tokenizerPromise;
}

/** How many word-pieces this text occupies, including special tokens. */
export async function countWordPieces(text: string): Promise<number> {
  if (!text) return 0;
  const tokenizer = await getTokenizer();
  const ids = await tokenizer.encode(text, { add_special_tokens: true });
  return ids.length;
}

/**
 * Measures word-pieces for a batch, which the tokenizer can do in one call.
 *
 * Chunker call sites are per-section, so batching buys little here, but keeping
 * the interface batch-shaped means a caller with a whole page in hand is not
 * forced into N round trips.
 */
export async function countWordPiecesBatch(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  const tokenizer = await getTokenizer();
  // The batch encoder is not on the base tokenizer type in this version of
  // transformers.js, and a sequential pass is cheap enough next to the
  // embedding that follows.
  const counts: number[] = [];
  for (const text of texts) {
    const ids = await tokenizer.encode(text, { add_special_tokens: true });
    counts.push(ids.length);
  }
  return counts;
}