export type SourceId = "python" | "fastapi" | "postgresql";

export interface SourceConfig {
  id: SourceId;
  label: string;
  /** Origin all URLs must start with. Enforced to avoid wandering off-site. */
  origin: string;
  /** Path prefix that identifies indexable pages. */
  includePrefix: string;
  /** URL path suffixes that are indexes, changelogs or marketing, not docs. */
  excludeExact: string[];
  /** How to discover the pages to fetch. */
  discovery: "toc" | "sitemap" | "crawl";
  discoveryEntry: string;
  /** Candidate CSS selectors for the main content region, most specific first. */
  contentSelectors: string[];
  /** Elements removed before extraction. */
  stripSelectors: string[];
  /** Heading levels that begin a new section. */
  headingSelector: string;
  /** Attribution shown in the UI and recorded in the database. */
  license: string;
  /** Respectful crawl settings. */
  crawl: { maxPages: number; concurrency: number; delayMs: number };
}

export const SOURCES: Record<SourceId, SourceConfig> = {
  python: {
    id: "python",
    label: "Python",
    origin: "https://docs.python.org",
    includePrefix: "https://docs.python.org/3/",
    excludeExact: ["/3/contents.html", "/3/index.html"],
    discovery: "toc",
    discoveryEntry: "https://docs.python.org/3/contents.html",
    contentSelectors: [
      'div[role="main"]',
      "div.body",
      "div.bodywrapper",
      "body",
    ],
    stripSelectors: [
      "nav",
      "header",
      "footer",
      "div.sphinxsidebar",
      "div.related",
      "div.sphinx-footer",
      "div[role='navigation']",
      "div.headerlink",
      "a.headerlink",
      "span.visually-hidden",
      "form",
      "script",
      "style",
    ],
    headingSelector: "h1, h2, h3, h4",
    license: "PSF License 2.0; code examples under Zero Clause BSD",
    crawl: { maxPages: 700, concurrency: 4, delayMs: 120 },
  },

  fastapi: {
    id: "fastapi",
    label: "FastAPI",
    origin: "https://fastapi.tiangolo.com",
    includePrefix: "https://fastapi.tiangolo.com/",
    // The site root is a marketing page (testimonials, conference banner),
    // not documentation.
    excludeExact: [
      "https://fastapi.tiangolo.com/",
      "https://fastapi.tiangolo.com/about/",
      "https://fastapi.tiangolo.com/community/",
      "https://fastapi.tiangolo.com/release-notes/",
      "https://fastapi.tiangolo.com/external/",
      "https://fastapi.tiangolo.com/newsletter/",
      "https://fastapi.tiangolo.com/robots.txt",
      "https://fastapi.tiangolo.com/sitemap.xml",
    ],
    discovery: "sitemap",
    discoveryEntry: "https://fastapi.tiangolo.com/sitemap.xml",
    contentSelectors: [
      "article.md-content__inner",
      "div.md-content__inner",
      "article",
      "main",
    ],
    stripSelectors: [
      "nav",
      "header",
      "footer",
      "div.md-sidebar",
      "div.md-header",
      "div.md-footer",
      "div.headerlink",
      "a.headerlink",
      "span.md-icon",
      "div.emoji",
      "div.tabbed-labels",
      "form",
      "script",
      "style",
    ],
    headingSelector: "h1, h2, h3",
    license: "MIT",
    crawl: { maxPages: 400, concurrency: 4, delayMs: 120 },
  },

  postgresql: {
    id: "postgresql",
    label: "PostgreSQL",
    origin: "https://www.postgresql.org",
    includePrefix: "https://www.postgresql.org/docs/current/",
    excludeExact: ["https://www.postgresql.org/docs/current/index.html"],
    discovery: "crawl",
    discoveryEntry: "https://www.postgresql.org/docs/current/index.html",
    contentSelectors: ["div#content", "div.refentry", "div#doc-content", "body"],
    stripSelectors: [
      "nav",
      "header",
      "footer",
      "div#header",
      "div#footer",
      "div#sidebar",
      "div#sidebar-right",
      "div#tools",
      "div#layout-content",
      "a.headerlink",
      "span.glyphicon",
      "form",
      "script",
      "style",
    ],
    headingSelector: "h1, h2, h3",
    license: "PostgreSQL License",
    // The PostgreSQL manual is large: the narrative chapters are only part of
    // it, and the sql-*.html reference pages (CREATE INDEX, ALTER TABLE, and
    // every other command) sort last alphabetically. Capping this low silently
    // drops the entire SQL Commands reference.
    crawl: { maxPages: 1500, concurrency: 4, delayMs: 150 },
  },
};

export const SOURCE_LIST: SourceConfig[] = [
  SOURCES.python,
  SOURCES.fastapi,
  SOURCES.postgresql,
];

export const SOURCE_IDS = SOURCE_LIST.map((s) => s.id);
