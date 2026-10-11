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
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/^\n+/, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\s+$/, "");
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
    const text = normaliseText(inlineBuffer.join(" "));
    inlineBuffer = [];
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
    const text = normaliseCode($el.text());
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
      const text = normaliseText(scope.find(element as never).text());
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
    sections: sections.filter((s) => s.blocks.length > 0),
  };
}

