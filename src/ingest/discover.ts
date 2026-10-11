/**
 * Works out which pages to fetch for a source, from the site's own index.
 * We prefer an explicit site-provided listing over blind crawling.
 */
import * as cheerio from "cheerio";
import { fetchHtml, checkRobots } from "./http";
import type { SourceConfig } from "./sources";

/** Pages that are indexes, changelogs or downloads rather than prose. */
const SKIP_PATTERNS = [
  /\/genindex(?:-[A-Z])?\.html?$/,
  /\/py-modindex\.html?$/,
  /\/search\.html?$/,
  /\/(changelog|whatsnew|news|release-notes|download|license|copyright|contents|index)\.html?$/i,
  /\/docs\/devel\//,
  /\/bugs\.html?$/,
  /\/help\//,
];

/** Collapse the /index.html and trailing-slash variants to one key. */
function urlKey(url: string): string {
  return url.replace(/\/index\.html$/, "/").replace(/\/+$/, "/");
}

export function isIndexableUrl(url: string, config: SourceConfig): boolean {
  if (!url.startsWith(config.includePrefix)) return false;
  if (!url.endsWith(".html") && !url.endsWith("/")) return false;

  const key = urlKey(url);
  if (config.excludeExact.some((excluded) => urlKey(excluded) === key)) return false;

  return !SKIP_PATTERNS.some((p) => p.test(url));
}

function normalise(base: string, href: string): string | null {
  try {
    const resolved = new URL(href, base);
    if (resolved.protocol !== "https:") return null;
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Discovery from a full table of contents page (Python's contents.html). */
async function discoverFromToc(config: SourceConfig): Promise<string[]> {
  const { body } = await fetchHtml(config.discoveryEntry, { delayMs: config.crawl.delayMs });
  const $ = cheerio.load(body);
  const urls = new Set<string>();
  $("a[href]").each((_, el) => {
    const url = normalise(config.discoveryEntry, $(el).attr("href") ?? "");
    if (url && isIndexableUrl(url, config)) urls.add(url);
  });
  return [...urls];
}

/** Discovery from sitemap.xml (FastAPI). */
async function discoverFromSitemap(config: SourceConfig): Promise<string[]> {
  const { body } = await fetchHtml(config.discoveryEntry, { delayMs: config.crawl.delayMs });
  const $ = cheerio.load(body);
  const urls = new Set<string>();

  const consider = (href: string) => {
    const url = normalise(config.discoveryEntry, href);
    if (url && isIndexableUrl(url, config)) urls.add(url);
  };

  if (body.includes("<sitemapindex")) {
    $("sitemap > loc").each((_, el) => consider($(el).text().trim()));
  } else {
    $("urlset > url > loc").each((_, el) => consider($(el).text().trim()));
  }
  return [...urls];
}

/**
 * Breadth-limited crawl from an index page (PostgreSQL, which has no
 * per-section sitemap). Depth is capped so we stay inside /docs/current/.
 */
async function discoverByCrawl(config: SourceConfig): Promise<string[]> {
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [
    { url: config.discoveryEntry, depth: 0 },
  ];

  while (queue.length > 0 && seen.size < config.crawl.maxPages * 3) {
    const { url, depth } = queue.shift()!;
    if (seen.has(url) || !isIndexableUrl(url, config) && depth > 0) continue;
    if (!(await checkRobots(url))) continue;
    seen.add(url);

    if (depth >= 2) continue;

    let body: string;
    try {
      ({ body } = await fetchHtml(url, { delayMs: config.crawl.delayMs }));
    } catch {
      continue;
    }

    const $ = cheerio.load(body);
    const links: string[] = [];
    $("a[href]").each((_, el) => {
      const resolved = normalise(url, $(el).attr("href") ?? "");
      if (resolved && isIndexableUrl(resolved, config)) links.push(resolved);
    });

    for (const link of links) {
      if (!seen.has(link)) queue.push({ url: link, depth: depth + 1 });
    }
  }

  return [...seen];
}

export async function discoverPages(config: SourceConfig): Promise<string[]> {
  let urls: string[] = [];
  try {
    if (config.discovery === "toc") urls = await discoverFromToc(config);
    else if (config.discovery === "sitemap") urls = await discoverFromSitemap(config);
    else urls = await discoverByCrawl(config);
  } catch (err) {
    console.warn(
      `  ! discovery failed for ${config.label}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }

  const permitted: string[] = [];
  for (const url of urls) {
    if (await checkRobots(url)) permitted.push(url);
  }

  permitted.sort();
  return permitted.slice(0, config.crawl.maxPages);
}
