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
 * Characters per word-piece in the densest content in the corpus.
 *
 * Prose runs about 5.0 and documentation reference blocks about 3.2, but
 * neither is the floor. Measured across ~15,800 real chunks from all three
 * manuals, the worst ratio is 1.33 - PostgreSQL's operator tables, where each
 * line is a handful of symbols like `>=(inet,inet)`. Python's complexity
 * tables reach 1.38 and FastAPI's contributor lists 1.86.
 *
 * Every ceiling in this file is sized against this number rather than against
 * prose, because a ceiling that is optimistic for the densest content is a
 * ceiling that truncates. It was fitted per-manual first and each manual was
 * denser than the last; 1.33 is the floor across all of them.
 *
 * The regression test measures this again against the real tokenizer, so the
 * assumption cannot rot as the corpus changes.
 */
const CODE_CHARS_PER_PIECE = 1.3;

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
 * Hard ceiling on a code block, in characters.
 *
 * A code block is normally never subdivided - cutting a sample mid-statement
 * is the damage this pipeline exists to avoid. But "never" had no upper bound,
 * and that exemption is exactly where truncation went unnoticed: FastAPI's
 * `TYPE:` / `DEFAULT:` reference sidebar produces single blocks up to 33,829
 * characters, which tokenise to 8,266 word-pieces. MiniLM truncates at 256, so
 * all but the first 3% of those passages were stored in the database and
 * invisible to every query.
 *
 * When a block exceeds this, it is split at *line* boundaries. A line break is
 * a syntactic boundary in every language in the corpus, so this preserves the
 * principle: no statement is ever cut in half. It just stops being unlimited.
 *
 * Derived from the model's limit rather than from the chunk target. Code
 * measures ~3.2 characters per word-piece against prose's ~5.0, so a ceiling
 * sized as a multiple of the target is optimistic by the time it reaches dense
 * code: the first attempt at targetTokens * 8 still overflowed at 464
 * word-pieces. Backing off to the measured code density leaves a chunk under
 * the limit at any language's word-piece rate.
 */
export const MAX_CODE_CHARS = Math.floor(
  (MAX_MODEL_TOKENS * CODE_CHARS_PER_PIECE) / 2,
);

/**
 * Largest chunk the merge step will assemble, in characters.
 *
 * all-MiniLM-L6-v2 truncates at 256 word-pieces (MAX_TOKENS in lib/embed).
 * Measured against the real tokenizer, the densest content in this corpus -
 * documentation reference blocks - runs about 3.2 characters per word-piece, so
 * this ceiling keeps a merged chunk inside the limit whether it holds prose or
 * code.
 *
 * Mirrors MAX_TOKENS deliberately rather than importing it: this module runs in
 * the ingestion CLI, and importing lib/embed would pull the ONNX runtime into
 * a process that never embeds anything. tests/chunk-model-fit.test.ts asserts
 * the two agree.
 */
export const MERGE_CHAR_CEILING = Math.floor(MAX_MODEL_TOKENS * CODE_CHARS_PER_PIECE);

/**
 * Move a slice off the end of `prev` and onto `last`, in place.
 *
 * Used when merging would overflow: rather than drop the runt, both chunks are
 * rebalanced across the boundary. Returns false when no usable boundary exists,
 * which leaves the caller to drop it as before.
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

    // Carry overlap forward only when doing so keeps the next chunk inside the
    // tokenizer's limit. On an already-ceiling-sized code piece the overlap
    // would push it over, and losing overlap is a far smaller cost than
    // losing the tail of the passage.
    const tail = overlapTail(text, options.overlapChars);
    carry = text.length + tail.length <= MERGE_CHAR_CEILING ? tail : "";
  }

  // Deal with a runt tail. A trailing chunk this small is almost always a
  // fragment rather than a retrievable passage, so it is folded into the
  // previous chunk - but only if the result still fits the tokenizer's limit.
  //
  // The ceiling is in characters, derived from the *densest* measured content
  // (code at ~3.2 chars/word-piece), so a merge is safe whatever it contains.
  //
  // When the merge would overflow, the tail is redistributed instead: a slice
  // is moved off the end of the previous chunk to join the runt. Dropping the
  // runt would lose text, and losing text is the one failure this whole module
  // exists to prevent - a passage that never reaches the index can never answer
  // a query.
  while (out.length > 1) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.tokenEstimate >= options.minTokens) break;

    const merged = `${prev.pageContent}\n\n${last.pageContent}`;
    if (merged.length <= MERGE_CHAR_CEILING) {
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

  // Final guard. Every rule above reasons from a block's declared `kind`, but
  // classification is not trustworthy enough to rely on alone:
  //
  //   - FastAPI's request-body examples arrive as prose, so MAX_CODE_CHARS
  //     never applied and an 800-character "prose" chunk tokenised at 3.2
  //     chars/word-piece instead of 5.0.
  //   - Dense non-Latin text does the same with no code involved: a "most
  //     starred repositories" list mixes symbols and CJK characters and reaches
  //     314 word-pieces in 790 characters.
  //
  // So size is checked against the densest measured rate regardless of what the
  // content claims to be, and anything still over is divided at line
  // boundaries. This runs after merging and renumbering, so nothing downstream
  // can reintroduce an oversized chunk.
  const safe = out.flatMap((chunk) => {
    if (chunk.pageContent.length <= MERGE_CHAR_CEILING) return [chunk];
    return splitCodeByLine(chunk.pageContent, MERGE_CHAR_CEILING).map((piece) =>
      makeChunk(piece, 0, chunk.headingPath),
    );
  });

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
