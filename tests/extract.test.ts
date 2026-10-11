import { describe, expect, it } from "vitest";
import { detectVersion, extractPage } from "../src/ingest/extract";
import { SOURCES } from "../src/ingest/sources";

/** Wrap body markup the way each generator would. */
function wrap(inner: string, container = "div[role='main']"): string {
  return `<html><head><title>Test</title></head><body>${container.replace(/'/g, '"').replace(/[[\]]/g, "") && ""}${inner}</body></html>`;
}

function html(inner: string): string {
  return `<!doctype html><html><head><title>Test page</title>
    <link rel="canonical" href="https://example.test/page.html"></head>
    <body><nav><a href="/skip">skip me</a></nav>
    <div role="main">${inner}</div>
    <footer>footer noise</footer></body></html>`;
}

const url = "https://example.test/page.html";
const config = { ...SOURCES.python, contentSelectors: ['div[role="main"]'] };

/**
 * A paragraph long enough to clear MIN_PASSAGE_CHARS. Sections below that
 * floor are deliberately dropped, so fixtures must use realistic lengths.
 */
const PARA = "A dependency is a callable that FastAPI can share across routes.";
const LONG = "PostgreSQL evaluates the query planner using statistics collected by ANALYZE.";

describe("detectVersion", () => {
  it("reads the Sphinx-style version out of the document title", () => {
    expect(detectVersion("Python 3.15.0 documentation")).toBe("3.15.0");
  });

  it("reads a PostgreSQL version", () => {
    expect(detectVersion("PostgreSQL 18 Documentation")).toBe("18");
  });

  it("returns null when there is no version marker", () => {
    expect(detectVersion("Some Ordinary Page")).toBeNull();
  });
});

describe("extractPage", () => {
  it("builds a nested heading path", () => {
    const page = extractPage(
      html(`
        <h1 id="top">Top</h1><p>${LONG} ${LONG}</p>
        <h2 id="second">Second</h2><p>${LONG} ${LONG}</p>
        <h3 id="third">Third</h3><p>${LONG} ${LONG}</p>
        <h2 id="fourth">Fourth</h2><p>${LONG} ${LONG}</p>
      `),
      url,
      config,
    );

    const paths = page.sections.map((s) => s.headingPath.join(" / "));
    expect(paths).toContain("Top");
    expect(paths).toContain("Top / Second");
    expect(paths).toContain("Top / Second / Third");
    expect(paths).toContain("Top / Fourth");
  });

  it("keeps a code block whole and does not leak navigation or footer text", () => {
    const snippet = [
      "from fastapi import Depends",
      "",
      "async def common(q: str | None = None):",
      "    if q:",
      "        return q",
      "    return q",
    ].join("\n");

    const page = extractPage(
      html(`<h1>Dependencies</h1><p>${PARA}</p><pre><code>${snippet}</code></pre><p>${LONG} ${LONG}</p>`),
      url,
      config,
    );

    const codeBlocks = page.sections.flatMap((s) => s.blocks.filter((b) => b.kind === "code"));
    expect(codeBlocks).toHaveLength(1);
    expect(codeBlocks[0].text).toBe(snippet);

    const all = page.sections.flatMap((s) => s.blocks.map((b) => b.text)).join(" ");
    expect(all).not.toContain("skip me");
    expect(all).not.toContain("footer noise");
  });

  it("preserves a code example nested inside a list item", () => {
    const page = extractPage(
      html(`
        <h1>Recipes</h1>
        <ul><li>Do this:<pre><code>result = db.query(sql)</code></pre></li></ul>
      `),
      url,
      config,
    );

    const all = page.sections.flatMap((s) => s.blocks.map((b) => b.text)).join("\n");
    expect(all).toContain("result = db.query(sql)");
  });

  it("strips the permalink glyph from headings", () => {
    const page = extractPage(
      html(`<h1 id="dep">Dependencies<a class="headerlink" href="#dep">¶</a></h1><p>${LONG} ${LONG}</p>`),
      url,
      config,
    );

    expect(page.sections[0].title).toBe("Dependencies");
    expect(page.sections[0].title).not.toContain("¶");
  });

  it("prefers the canonical URL when the page declares one", () => {
    const page = extractPage(html(`<h1>T</h1><p>${LONG} ${LONG}</p>`), url, config);
    expect(page.canonicalUrl).toBe("https://example.test/page.html");
  });

  it("drops sections that ended up with no content", () => {
    const page = extractPage(
      html(`
        <h1>Empty</h1>
        <h2>Also empty</h2>
        <h3>Real</h3><p>${LONG} ${LONG}</p>
      `),
      url,
      config,
    );
    expect(page.sections.every((s) => s.blocks.length > 0)).toBe(true);
    expect(page.sections.map((s) => s.title)).toEqual(["Real"]);
  });

  it("drops navigation-only sections such as bare cross-reference links", () => {
    // PostgreSQL "See Also" blocks are link labels with no sentence
    // punctuation. They score well on lexical overlap but explain nothing.
    const page = extractPage(
      html(`
        <h1>VACUUM</h1><p>${"The VACUUM command reclaims storage. ".repeat(6)}</p>
        <h2>See Also</h2><p>ANALYZE</p>
        <h2>Options</h2><p>${"This option controls how much detail is printed. ".repeat(6)}</p>
      `),
      url,
      config,
    );

    const titles = page.sections.map((s) => s.title);
    expect(titles).not.toContain("See Also");
    expect(titles).toContain("Options");
  });

  it("keeps a code-only section however short it is", () => {
    // No prose, no punctuation - but a runnable snippet is the answer.
    const page = extractPage(
      html(`<h1>Recipes</h1><p>Run:</p><pre><code>result = db.query(sql)</code></pre>`),
      url,
      config,
    );

    const all = page.sections.flatMap((s) => s.blocks.map((b) => b.text)).join("\n");
    expect(all).toContain("result = db.query(sql)");
  });

  it("flattens a table into readable rows", () => {
    const page = extractPage(
      html(`
        <h1>CREATE INDEX options</h1>
        <p>${"The following options may be given when creating an index. ".repeat(6)}</p>
        <table><tr><th>Name</th><th>Type</th></tr><tr><td>CONCURRENTLY</td><td>boolean</td></tr></table>
      `),
      url,
      config,
    );

    const all = page.sections.flatMap((s) => s.blocks.map((b) => b.text)).join("\n");
    expect(all).toContain("Name | Type");
    expect(all).toContain("CONCURRENTLY | boolean");
  });
});

void wrap;
