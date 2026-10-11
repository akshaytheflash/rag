/**
 * Turns a documentation page into ordered sections.
 *
 * The three documentation sets are built with different generators (Sphinx,
 * MkDocs Material, PostgreSQL's own SGML toolchain), but they share one
 * structure: a main content region containing headings and a flow of text and
 * code blocks. One generic walker handles all three, configured per source.
 *
 * Two rules matter for retrieval quality:
 *   1. A heading starts a new section, so a chunk always knows where it came
 *      from and can cite the full heading path.
 *   2. A <pre> block is atomic. Code examples are never split, reflowed or
 *      trimmed mid-statement - not even when they sit inside a list item.
 */
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import type { SourceConfig } from "./sources";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string; language: string | null };

export interface Section {
  headingPath: string[];
  title: string;
  anchor: string;
  blocks: Block[];
}

export interface ExtractedPage {
  url: string;
  canonicalUrl: string;
  title: string;
  version: string | null;
  sections: Section[];
}

/** Tags whose text is treated as part of the surrounding sentence. */
const INLINE_TAGS = new Set([
  "span", "a", "code", "em", "strong", "b", "i", "tt", "kbd", "samp", "var",
  "abbr", "cite", "q", "small", "sub", "sup", "mark", "time", "label",
  "img", "br", "wbr", "u", "s", "del", "ins", "output", "data", "dfn",
]);

/** Collapse whitespace runs without destroying paragraph breaks. */
function normaliseText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ ]*\n[ ]*/g, "\n")
    .trim();
}

/**
 * Is this a block of encoded binary rather than readable documentation?
 *
 * Documentation sites embed images as inline base64. FastAPI ships one on a
 * single 4,269-character line, which is the worst case for the chunker: there
 * is no line boundary to split at, so it cannot be divided without corrupting
 * it, and nothing would ever match it. It is dropped rather than indexed.
 *
 * Deliberately narrow. Real code can contain long unbroken alphanumeric runs,
 * so the only reliable signal is an explicit data-URI prefix, plus the case
 * where a single line is enormous and carries no spaces or punctuation at all
 * - a shape no readable code or prose takes.
 */
/**
 * Is this a block of encoded binary rather than readable documentation?
 *
 * Documentation sites embed images as inline base64. FastAPI ships one that
 * runs to several thousand characters, which is the worst case for the chunker:
 * no line boundary to split at, so it cannot be divided without corrupting it,
 * and nothing would ever match it.
 *
 * Note this runs on the *rendered* text, not the raw HTML. Pygments splits a
 * statement into spans, and joining them inserts spaces - so
 * `image_base64 = "iVBOR..."` reaches the chunker as
 * `image_base64 = " iVBOR...`. The pattern below tolerates that spacing, which
 * a shape check on punctuation cannot: by the time the spaces are in, the line
 * contains `=` and quotes and looks like ordinary code.
 */
function isEncodedBlob(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 512) return false;
  if (/^data:[\w.+-]+;\s*base64,/i.test(trimmed)) return true;

  // Spaces around the assignment and the quote are the syntax highlighter's
  // doing, so the pattern is matched against the text with all whitespace
  // removed - which collapses `image_base64 = " iVBOR` to `image_base64="iVBOR`.
  const squashed = trimmed.replace(/\s+/g, "");
  return /[a-z0-9_.]*(?:base64|image|img|icon|avatar|png|jpeg|jpg|gif|svg)[a-z0-9_.]*=["'][A-Za-z0-9+/]{512,}={0,2}["']/i.test(
    squashed,
  );
}

/**
 * Is this a run of bare @mentions or handles with no prose around it?
 *
 * FastAPI ships contributor lists that are one long line of `@handle` tokens.
 * There is no line boundary to split at, and no sentence to retrieve - a query
 * would have to match a handle to surface it. Left in, it occupies a chunk slot
 * and, being dense, risks a passage the model will truncate.
 */
function isMentionList(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 512) return false;
  const handles = trimmed.match(/@[\w.-]+/g);
  if (!handles || handles.length < 8) return false;
  // Only true if the handles account for essentially all of the text, so an
  // ordinary paragraph that merely mentions a few accounts is never dropped.
  // Newlines are allowed: the source wraps these lists across several lines.
  const covered = handles.join("").length;
  return covered / trimmed.replace(/\s+/g, "").length > 0.9;
}

/**
 * Strip the permalink glyph generators append inside heading anchors
 * (MkDocs "Â¶", Sphinx "Â¶", Sphinx "#").
 */
function cleanHeading(text: string): string {
  return normaliseText(text)
    .replace(/[\u00b6\u00a7#\u00bb]+\s*$/u, "")
    .replace(/^[\s\u00b6#]+/u, "")
    .trim();
}

/**
 * Clean code text. Leading blank lines are dropped and trailing padding is
 * removed, but the first line's indentation is preserved - trimming it would
 * silently alter the code.
 */
function normaliseCode(text: string): string {
  return cleanDiagramMarkup(text)
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^\n+/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+$/, "");
}

/**
 * Reduce embedded markup in diagram sources to readable text.
 *
 * Mermaid diagrams are stored in the page as source text with HTML inline for
 * line breaks (`<br/>`), which lands in the index as literal tags. Those tags
 * are noise to a sentence encoder - they cost word-pieces and shift the
 * embedding away from the diagram's actual meaning - and `<br/>` is a line
 * break in every language the diagrams are written in.
 *
 * Only the tags inside these blocks are touched. Anything that looks like
 * genuine markup in a `<pre>` is unusual enough that removing the tag and
 * keeping its text is still the better outcome for a text index.
 */
function cleanDiagramMarkup(text: string): string {
  if (!/<\/?[a-z][^>]*>/i.test(text)) return text;
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(?:b|i|em|u|strong|code|span|font|div|p|sub|sup)\b[^>]*>/gi, "")
    .replace(/&nbsp;/g, " ");
}

function pickRoot($: cheerio.CheerioAPI, selectors: string[]): cheerio.Cheerio<never> {
  for (const selector of selectors) {
    const found = $(selector).first();
    if (found.length > 0) return found as unknown as cheerio.Cheerio<never>;
  }
  return $("body").first() as unknown as cheerio.Cheerio<never>;
}

function elementLanguage(el: Element): string | null {
  const attribs = el.attribs ?? {};
  const match = (attribs.class ?? "").match(/language-([\w+#-]+)/);
  if (match) return match[1];
  return attribs["data-lang"] ?? attribs["data-language"] ?? null;
}

/**
 * Is this section a navigation block rather than documentation?
 *
 * Cross-reference blocks ("See Also", "References") are lists of link labels
 * with no sentence punctuation - PostgreSQL's are frequently a single word
 * like "VACUUM", though some run to a hundred characters. They score well on
 * lexical overlap while explaining nothing, so they displace the passage that
 * actually answers the question.
 *
 * Prose always contains sentence punctuation, and a section carrying a code
 * example is always worth keeping, so both are exempt. Length is only used to
 * bound the rule; it cannot separate the classes on its own.
 */
function isNavigationalOnly(section: Section): boolean {
  if (section.blocks.some((block) => block.kind === "code")) return false;

  const text = section.blocks.map((block) => block.text).join(" ");
  if (text.length >= 400) return false;

  return !/[.!?]/.test(text);
}

/** Version detection from the page title, e.g. "3.15.0 documentation". */
export function detectVersion(title: string): string | null {
  const patterns = [
    /\b(\d+\.\d+\.\d+[a-z0-9]*)\s+documentation\b/i, // Sphinx / Python
    /\bPython\s+(\d+\.\d+\.\d+)\b/i,
    /\bPostgreSQL\s+(\d+(?:\.\d+)*)\b/i,
    /\bv(\d+\.\d+\.\d+)\b/, // FastAPI version selector
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function extractPage(html: string, pageUrl: string, config: SourceConfig): ExtractedPage {
  const $ = cheerio.load(html);

  const canonical =
    $('link[rel="canonical"]').attr("href")?.trim() ||
    $('meta[property="og:url"]').attr("content")?.trim() ||
    pageUrl;

  const rawTitle = $("h1").first().text().trim() || $("title").text().trim();
  const documentTitle = $("title").text().trim() || rawTitle;
  const title = cleanHeading(rawTitle) || new URL(pageUrl).pathname;

  const root = pickRoot($, config.contentSelectors);
  const scope = root.clone();
  for (const selector of config.stripSelectors) scope.find(selector).remove();

  const headingTags = new Set(config.headingSelector.split(",").map((t) => t.trim()));

  const sections: Section[] = [];
  const headingStack: { level: number; text: string }[] = [];
  let current: Section | null = null;
  let inlineBuffer: string[] = [];

  const flushInline = () => {
    if (inlineBuffer.length === 0) return;
    const inlineText = inlineBuffer.join(" ");
    inlineBuffer = [];
    // Contributor lists reach here as prose rather than as a <pre>, so the
    // mention filter has to run on this path too.
    if (isMentionList(inlineText)) return;
    const text = normaliseText(inlineText);
    if (!text) return;
    if (!current) {
      current = { headingPath: [], title, anchor: "", blocks: [] };
      sections.push(current);
    }
    current.blocks.push({ kind: "text", text });
  };

  const pushCode = (el: Element) => {
    flushInline();
    const $el = scope.find(el as never);
    const text = normaliseCode(isEncodedBlob($el.text()) || isMentionList($el.text()) ? "" : $el.text());
    if (!text) return;
    if (!current) {
      current = { headingPath: [], title, anchor: "", blocks: [] };
      sections.push(current);
    }
    current.blocks.push({ kind: "code", text, language: elementLanguage(el) });
  };

  const pushTable = (el: Element) => {
    flushInline();
    const $el = scope.find(el as never);
    const rows: string[] = [];
    $el.find("tr").each((__, tr) => {
      const cells = $el
        .find(tr)
        .find("th,td")
        .map((___, cell) => normaliseText($el.find(cell).text()))
        .get()
        .filter(Boolean);
      if (cells.length) rows.push(cells.join(" | "));
    });
    const text = normaliseText(rows.join("\n"));
    if (!text) return;
    if (!current) {
      current = { headingPath: [], title, anchor: "", blocks: [] };
      sections.push(current);
    }
    current.blocks.push({ kind: "text", text });
  };

  const startSection = (el: Element) => {
    flushInline();
    const $el = scope.find(el as never);
    const text = cleanHeading($el.text());
    if (!text) return;
    const level = Number(el.tagName.slice(1));

    while (headingStack.length && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop();
    }
    headingStack.push({ level, text });

    current = {
      headingPath: headingStack.map((h) => h.text),
      title: text,
      anchor: ($el.attr("id") ?? "").trim(),
      blocks: [],
    };
    sections.push(current);
  };

  /**
   * Classify a node, then recurse into it if it is a container.
   * One function rather than a "classify children" walk, so a heading that
   * sits at the very top of the content region is treated the same as one
   * nested three wrappers deep.
   */
  const handle = (element: Element) => {
    const tag = element.tagName?.toLowerCase() ?? "";

    if (headingTags.has(tag)) {
      startSection(element);
      return;
    }
    if (tag === "pre") {
      pushCode(element);
      return;
    }
    if (tag === "p") {
      flushInline();
      const raw = scope.find(element as never).text();
      // A whole paragraph arrives here rather than through the inline buffer,
      // so the mention filter has to run on this path too. FastAPI's
      // contributor list is exactly this shape.
      if (isMentionList(raw)) return;
      const text = normaliseText(raw);
      if (text) {
        if (!current) {
          current = { headingPath: [], title, anchor: "", blocks: [] };
          sections.push(current);
        }
        current.blocks.push({ kind: "text", text });
      }
      return;
    }
    if (tag === "table") {
      pushTable(element);
      return;
    }
    if (tag === "ul" || tag === "ol" || tag === "dl" || tag === "blockquote" || tag === "figure") {
      flushInline();
    }
    if (INLINE_TAGS.has(tag)) {
      inlineBuffer.push(scope.find(element as never).text());
      return;
    }

    // Any other element (div, section, li, dd, dt, details, ...) is a
    // container: keep descending so nested code blocks survive.
    for (const child of element.children ?? []) {
      if ("tagName" in child) handle(child as Element);
    }
  };

  scope.each((_, element) => {
    for (const child of (element as Element).children ?? []) {
      if ("tagName" in child) handle(child as Element);
    }
  });

  flushInline();

  return {
    url: pageUrl,
    canonicalUrl: canonical,
    title,
    version: detectVersion(documentTitle),
    // Drop navigation-only blocks so they cannot displace real answers.
    // Individual blocks are never trimmed: a short line inside a real section
    // ("Deprecated since 3.1.") is meaningful and must survive.
    sections: sections.filter((section) => !isNavigationalOnly(section)),
  };
}

