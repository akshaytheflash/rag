/**
 * Splits a section into retrievable passages.
 *
 * Invariants:
 *   - A code block is never split. If a code block alone exceeds the target
 *     size it becomes its own chunk rather than being cut mid-statement.
 *   - Every chunk carries the full heading path, so a result can be cited
 *     without re-reading the page.
 *   - Consecutive chunks from the same section overlap slightly, so a sentence
 *     that straddles a boundary is still fully retrievable.
 */
import type { Block, Section } from "./extract";

export interface ChunkOptions {
  /** Approximate token target per chunk. */
  targetTokens: number;
  /** Overlap between consecutive chunks within a section, in characters. */
  overlapChars: number;
  /** Chunks shorter than this are merged into the previous chunk. */
  minTokens: number;
}

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

/** Rough token estimate. Good enough for budgeting; never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ChunkRecord {
  ordinal: number;
  headingPath: string[];
  text: string;
  tokenEstimate: number;
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
 */
function splitProse(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const sentences = text.match(/[^.!?\n]*[.!?]+\s*|[^.!?\n]+\n?/g) ?? [text];
  const parts: string[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > limit) {
      parts.push(buffer.trimEnd());
      buffer = "";
    }
    buffer += sentence;

    // A single sentence longer than the limit still has to be cut somewhere.
    while (buffer.length > limit) {
      parts.push(buffer.slice(0, limit));
      buffer = buffer.slice(limit);
    }
  }

  if (buffer.trim()) parts.push(buffer.trimEnd());
  return parts.filter((p) => p.length > 0);
}

/**
 * Pack blocks into chunks up to the token target, keeping code atomic.
 * Returns blocks grouped by chunk.
 */
function packBlocks(blocks: Block[], targetChars: number): Block[][] {
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
    // Prose is subdivided at sentence boundaries; code is never subdivided.
    const pieces =
      block.kind === "text" ? splitProse(block.text, targetChars) : [block.text];

    for (const piece of pieces) {
      const blockSize = piece.length;
      const unit: Block =
        piece === block.text ? block : { ...block, text: piece } as Block;

      if (blockSize > targetChars) {
        // Only an oversized *code* block reaches this branch.
        commit();
        groups.push([unit]);
        continue;
      }

      if (size + blockSize > targetChars && current.length > 0) commit();
      current.push(unit);
      size += blockSize;
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

export function chunkSection(
  section: Section,
  ordinalStart: number,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkRecord[] {
  const targetChars = options.targetTokens * 4;
  const groups = packBlocks(section.blocks, targetChars);
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

    out.push({
      ordinal: ordinal++,
      headingPath: section.headingPath,
      text,
      tokenEstimate: estimateTokens(text),
    });

    carry = overlapTail(text, options.overlapChars);
  }

  // Deal with a runt tail. A trailing chunk this small is almost always a
  // fragment rather than a retrievable passage, so prefer folding it into the
  // previous chunk and, failing that, dropping it.
  while (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.tokenEstimate >= options.minTokens) break;

    if (prev.tokenEstimate + last.tokenEstimate <= options.targetTokens * 1.5) {
      prev.text = `${prev.text}\n\n${last.text}`;
      prev.tokenEstimate = estimateTokens(prev.text);
      out.pop();
    } else {
      // The previous chunk is already full; a 2-token fragment adds noise to
      // the index and can never win a search on its own.
      out.pop();
    }
  }

  // Re-number so ordinals stay dense and predictable.
  out.forEach((chunk, i) => {
    chunk.ordinal = ordinalStart + i;
  });

  return out;
}

export interface PageChunking {
  chunks: ChunkRecord[];
  /** Chunk ordinals start fresh per page. */
  count: number;
}

/** Chunks an entire page, numbering continuously across its sections. */
export function chunkPage(
  sections: Section[],
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkRecord[] {
  const all: ChunkRecord[] = [];
  for (const section of sections) {
    all.push(...chunkSection(section, all.length, options));
  }
  return all;
}
