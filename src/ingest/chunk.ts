/**
 * Splits a section into retrievable passages.
 *
 * Prose splitting is delegated to LangChain's RecursiveCharacterTextSplitter,
 * which walks a hierarchy of separators (paragraph, line, sentence, word) and
 * only ever falls back to a hard cut once every separator is exhausted. That
 * is strictly better than a hand-rolled regex at keeping sentences intact.
 *
 * Two things LangChain's splitter does not know about, and which this module
 * therefore still owns:
 *   - A code block is never split. If a code block alone exceeds the target
 *     size it becomes its own chunk rather than being cut mid-statement.
 *   - Every chunk carries the full heading path, so a result can be cited
 *     without re-reading the page.
 */
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { countWordPieces, countWordPiecesBatch } from "../lib/tokenize";
import type { Block, Section } from "./extract";

export interface ChunkOptions {
  /** Approximate token target per chunk. */
  targetTokens: number;
  /** Overlap between consecutive chunks within a section, in characters. */
  overlapChars: number;
  /** Chunks shorter than this are merged into the previous chunk. */
  minTokens: number;
}

/** Word-piece position limit of the embedding model. See lib/embed.MAX_TOKENS. */
export const MAX_MODEL_TOKENS = 256;

/**
 * Target chunk size, in estimated tokens.
 *
 * This is capped deliberately. all-MiniLM-L6-v2 has a 256 word-piece position
 * limit, and measured against the real tokenizer a 1,280-character chunk of
 * documentation prose tokenises to roughly 340 word-pieces. Anything past 256
 * is silently truncated before it is embedded, which means the tail of a
 * long passage is stored but can never be matched by a query.
 *
 * At ~4 characters per estimated token, 200 keeps chunks around 800
 * characters / ~190 word-pieces: fully embedded, with margin for code blocks
 * that tokenise more densely than prose.
 */
export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetTokens: 200,
  overlapChars: 200,
  minTokens: 20,
};

/**
 * Coarse ceiling on a code block, in characters.
 *
 * A code block is normally never subdivided - cutting a sample mid-statement
 * is the damage this pipeline exists to avoid - but "never" had no upper bound,
 * and that exemption is where truncation hid: FastAPI's `TYPE:` / `DEFAULT:`
 * sidebar produced single blocks of 33,829 characters, which tokenise to 8,266
 * word-pieces against a 256 limit. Only the first 3% was ever embedded.
 *
 * When a block exceeds this it is split at *line* boundaries. A newline is a
 * syntactic boundary in every language in the corpus, so no statement is ever
 * cut in half. The principle survives; it just stops being unconditional.
 *
 * This is a coarse first cut, not the guarantee. It decides only how coarsely
 * to subdivide; enforceModelLimit() then measures the result with the real
 * tokenizer and divides further if it still does not fit.
 */
export const MAX_CODE_CHARS = 1600;

/** Rough token estimate. Good enough for budgeting; never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * A retrievable passage, shaped as a LangChain Document so the index is
 * interchangeable with any LangChain vector store or retriever.
 *
 * Provenance lives in `metadata`; the passage text itself is `pageContent`.
 */
export type ChunkRecord = Document & {
  ordinal: number;
  headingPath: string[];
  tokenEstimate: number;
};

function makeChunk(
  text: string,
  ordinal: number,
  headingPath: string[],
): ChunkRecord {
  const doc = new Document({ pageContent: text, metadata: { ordinal, headingPath } });
  return Object.assign(doc, {
    ordinal,
    headingPath,
    tokenEstimate: estimateTokens(text),
  });
}

function renderBlocks(blocks: Block[]): string {
  const text = blocks.map((block) => block.text).join("\n\n");
  const trimmedEnd = text.replace(/\s+$/, "");
  // Trim leading whitespace only for prose. A chunk that opens with a code
  // block keeps its indentation, because trimming it would alter the code.
  return blocks[0]?.kind === "text" ? trimmedEnd.replace(/^\s+/, "") : trimmedEnd;
}

/**
 * Split an oversized prose block at sentence boundaries.
 *
 * Only prose is split. A code block that is larger than the target is kept
 * whole, because cutting a code sample mid-statement is exactly the damage
 * this pipeline exists to avoid.
 *
 * Lengths are handled in characters rather than tokens: the splitter's
 * lengthFunction is the unit, and estimateTokens() is a fixed chars/4 ratio,
 * so splitting here and packing there stay consistent.
 *
 * The splitter's own overlap is zero. Overlap is applied once, at chunk
 * boundaries, by overlapTail() below - leaving both in place would duplicate
 * text inside a chunk and dilute its embedding.
 */
async function splitProse(text: string, limit: number): Promise<string[]> {
  if (text.length <= limit) return [text];

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: limit,
    chunkOverlap: 0,
    // Walk down from the most semantic boundary to the least. Keeping the
    // separator attached means a chunk still ends mid-sentence only when
    // nothing else fits.
    separators: ["\n\n", "\n", ". ", "? ", "! ", "; ", ", ", " ", ""],
    keepSeparator: true,
    lengthFunction: (value: string) => value.length,
  });

  const parts = await splitter.splitText(text);
  return parts.filter((part) => part.trim().length > 0);
}

/**
 * Split an oversized code block at line boundaries.
 *
 * The last resort, reached only when a code block exceeds MAX_CODE_CHARS. A
 * newline is a syntactic boundary in every language in this corpus, so each
 * piece is still syntactically whole - unlike a mid-word hard cut, which is
 * what actually happens to the text if we simply refuse to split.
 *
 * A single line longer than the ceiling is emitted as-is rather than being cut:
 * that case (a minified blob or a very long table row) has no safe split point,
 * and one oversized chunk is a smaller problem than a corrupted one.
 */
export function splitCodeByLine(text: string, limit: number = MAX_CODE_CHARS): string[] {
  if (text.length <= limit) return [text];

  const lines = text.split("\n");
  const out: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) out.push(current.replace(/\n+$/, ""));
    current = "";
  };

  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      flush();
      current = line;
    } else {
      current = candidate;
    }
  }
  flush();

  return out.length > 0 ? out : [text];
}

/**
 * Pack blocks into chunks up to the token target, keeping code atomic.
 * Returns blocks grouped by chunk.
 */
async function packBlocks(blocks: Block[], targetChars: number): Promise<Block[][]> {
  const groups: Block[][] = [];
  let current: Block[] = [];
  let size = 0;

  const commit = () => {
    if (current.length > 0) {
      groups.push(current);
      current = [];
      size = 0;
    }
  };

  for (const block of blocks) {
    if (block.kind === "text") {
      // Prose is subdivided at sentence boundaries, then repacked up to the
      // target.
      const pieces = await splitProse(block.text, targetChars);
      for (const piece of pieces) {
        const blockSize = piece.length;
        if (size + blockSize > targetChars && current.length > 0) commit();
        current.push(piece === block.text ? block : ({ ...block, text: piece } as Block));
        size += blockSize;
      }
      continue;
    }

    // Code is committed one split piece at a time and never repacked.
    //
    // Repacking is what defeated the ceiling: pieces already sized to fit the
    // tokenizer were gathered back up to targetChars, then the overlap carry
    // added ~200 more on top, producing 289 word-pieces against a 256 limit.
    // A piece that was split *because* it was too big must not be merged with
    // its neighbours into something too big again.
    for (const piece of splitCodeByLine(block.text)) {
      commit();
      current.push(piece === block.text ? block : ({ ...block, text: piece } as Block));
      size = piece.length;
    }
  }

  commit();
  return groups;
}

/** Trailing text of a rendered chunk, used as overlap for the next one. */
function overlapTail(text: string, overlapChars: number): string {
  if (overlapChars <= 0 || text.length <= overlapChars) return "";
  // Prefer to cut at a sentence boundary so overlap reads cleanly.
  const window = text.slice(-overlapChars);
  const boundary = window.search(/[.!?]\s+\S/);
  if (boundary !== -1 && boundary < window.length * 0.5) {
    return window.slice(boundary + 1).trim();
  }
  return window.trim();
}

/**
 * Move a slice off the end of `prev` and onto `last`, in place.
 *
 * Used when merging would make the result too large: rather than drop the runt,
 * both chunks are rebalanced across the boundary. Returns false when no usable
 * boundary exists, which leaves the caller to drop it as before.
 *
 * Cuts only at sentence boundaries. A split mid-sentence would leave two
 * fragments, neither of which stands alone - the opposite of the point.
 */
function rebalanceTail(prev: ChunkRecord, last: ChunkRecord, minTokens: number): boolean {
  const need = (minTokens - last.tokenEstimate) * 4;
  if (need <= 0) return false;

  const window = prev.pageContent;
  for (let cut = window.length - need; cut > window.length * 0.4; cut--) {
    if (!/[.!?]\s/.test(window.slice(cut - 1, cut + 1))) continue;
    const movedText = window.slice(cut).trim();
    const keptText = window.slice(0, cut).trimEnd();
    if (estimateTokens(movedText) < minTokens || !keptText) continue;

    Object.assign(prev, {
      pageContent: keptText,
      tokenEstimate: estimateTokens(keptText),
    });
    prev.metadata = { ...prev.metadata, pageContent: keptText };

    const grown = `${movedText}\n\n${last.pageContent}`;
    Object.assign(last, {
      pageContent: grown,
      tokenEstimate: estimateTokens(grown),
    });
    last.metadata = { ...last.metadata, pageContent: grown };
    return true;
  }
  return false;
}

export async function chunkSection(
  section: Section,
  ordinalStart: number,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<ChunkRecord[]> {
  const targetChars = options.targetTokens * 4;
  const groups = await packBlocks(section.blocks, targetChars);
  const out: ChunkRecord[] = [];

  let carry = "";
  let ordinal = ordinalStart;

  for (const group of groups) {
    let text = renderBlocks(group);
    if (carry) {
      text = `${carry}\n\n${text}`;
      carry = "";
    }
    if (!text) continue;

    out.push(makeChunk(text, ordinal++, section.headingPath));

    // Carry overlap forward only when the result still fits. On an
    // already-ceiling-sized piece the overlap would push it over, and losing
    // overlap costs far less than losing the tail of a passage. enforceModelLimit
    // would catch it either way; skipping it here avoids the fragmentation.
    const tail = overlapTail(text, options.overlapChars);
    carry = tail && text.length + tail.length <= targetChars * 2 ? tail : "";
  }

  // Deal with a runt tail. A trailing chunk this small is almost always a
  // fragment rather than a retrievable passage, so it is folded into the
  // previous chunk - but only if the result stays within a sane size. The
  // tokenizer has the final say; see enforceModelLimit.
  //
  // When merging would make the result unreasonably large, the tail is
  // redistributed instead: a slice is moved off the end of the previous chunk
  // to join the runt. Dropping the runt would lose text, and losing text is
  // the one failure this whole module exists to prevent - a passage that never
  // reaches the index can never answer a query.
  while (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.tokenEstimate >= options.minTokens) break;

    const merged = `${prev.pageContent}\n\n${last.pageContent}`;
    if (merged.length <= targetChars * 2) {
      Object.assign(prev, {
        pageContent: merged,
        tokenEstimate: estimateTokens(merged),
      });
      prev.metadata = { ...prev.metadata, pageContent: merged };
      out.pop();
      continue;
    }

    // Redistribute: move the tail of `prev` onto the runt so both sides clear
    // minTokens and the limit, instead of discarding either one.
    const moved = rebalanceTail(prev, last, options.minTokens);
    if (!moved) {
      // No sentence boundary available to move. Dropping is the only option,
      // and it is the same behaviour this module had before.
      out.pop();
    }
  }

  return enforceModelLimit(out, ordinalStart);
}

/**
 * The guarantee that no chunk reaches the index in a form the model truncates.
 *
 * Every other rule in this file is a heuristic about characters, and all of
 * them are wrong for some part of the corpus - prose runs 5.0 characters per
 * word-piece, PostgreSQL's operator tables 1.33, and the block's declared
 * `kind` is not always honest about which it holds. This step measures the
 * actual tokenisation and divides anything that does not fit, at line
 * boundaries, repeatedly if necessary.
 *
 * Measuring costs one tokenizer pass over text that is about to be embedded
 * anyway. Guessing was cheaper and demonstrably wrong twice: a 3.2 constant
 * left 32 chunks per 60 pages truncated, and a 1.33 constant - correct for the
 * densest content - fragmented the FastAPI corpus from 2,803 chunks into
 * 11,702 by cutting perfectly good prose into fragments. Neither failure
 * announced itself; only measuring the output catches both.
 */
async function enforceModelLimit(
  chunks: ChunkRecord[],
  ordinalStart: number,
): Promise<ChunkRecord[]> {
  const safe: ChunkRecord[] = [];

  for (const chunk of chunks) {
    // Split proportionally to what was measured, then correct.
    //
    // Halving from length/2 was tried first and overshoots badly: a chunk only
    // slightly over the limit gets cut in half anyway, which is why it dropped
    // the average FastAPI passage from 753 to 380 characters. Smaller passages
    // retrieve worse, because a fragment has lost the context that made it
    // match in the first place. Scaling by the measured overage keeps pieces as
    // large as they can be and still fit.
    const measured = await countWordPieces(chunk.pageContent);
    if (measured <= MAX_MODEL_TOKENS) {
      safe.push(chunk);
      continue;
    }

    const proportional = Math.max(
      1,
      Math.floor((chunk.pageContent.length * MAX_MODEL_TOKENS) / measured),
    );
    let limit = proportional;
    let pieces = splitCodeByLine(chunk.pageContent, limit);

    // Correct in both directions: halve if still too big, and grow back while
    // there is headroom, so the split lands just inside the limit.
    while (pieces.length > 1) {
      const counts = await countWordPiecesBatch(pieces);
      const worst = Math.max(...counts);
      if (worst <= MAX_MODEL_TOKENS) {
        if (worst < MAX_MODEL_TOKENS * 0.85 && limit < chunk.pageContent.length) {
          limit = Math.min(chunk.pageContent.length, limit * 2);
          const grown = splitCodeByLine(chunk.pageContent, limit);
          if (grown.length < pieces.length) {
            const grownCounts = await countWordPiecesBatch(grown);
            if (Math.max(...grownCounts) > MAX_MODEL_TOKENS) break;
            pieces = grown;
            continue;
          }
        }
        break;
      }
      const next = Math.max(1, Math.floor(limit / 2));
      if (next === limit) break; // granularity exhausted; nothing left to try
      limit = next;
      pieces = splitCodeByLine(chunk.pageContent, limit);
    }

    for (const piece of pieces) {
      safe.push(makeChunk(piece, 0, chunk.headingPath));
    }
  }

  // Re-number so ordinals stay dense and predictable.
  safe.forEach((chunk, i) => {
    chunk.ordinal = ordinalStart + i;
  });

  return safe;
}

export interface PageChunking {
  chunks: ChunkRecord[];
  /** Chunk ordinals start fresh per page. */
  count: number;
}

/** Chunks an entire page, numbering continuously across its sections. */
export async function chunkPage(
  sections: Section[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): Promise<ChunkRecord[]> {
  const all: ChunkRecord[] = [];
  for (const section of sections) {
    all.push(...(await chunkSection(section, all.length, options)));
  }
  return all;
}
