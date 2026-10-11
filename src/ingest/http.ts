/**
 * A deliberately well-behaved HTTP client for crawling documentation.
 *
 * - Identifies itself with a contactable User-Agent.
 * - Serialises requests through a per-host queue with a fixed delay, so we
 *   never burst a site.
 * - Caches responses on disk (.cache/, gitignored) keyed by URL, so re-runs
 *   for incremental updates do not re-fetch unchanged pages.
 * - Honours robots.txt Disallow rules for the hosts we touch.
 */
import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = path.resolve(process.cwd(), ".cache", "http");
const USER_AGENT =
  "docsearch-indexer/1.0 (semantic search demo; +https://github.com/akshaytheflash/rag)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function cachePath(url: string): string {
  const key = Buffer.from(url).toString("base64url").slice(0, 180);
  return path.join(CACHE_DIR, `${key}.txt`);
}

/** Per-host serialisation with a polite delay between requests. */
class HostQueue {
  private tails = new Map<string, Promise<unknown>>();
  private last = new Map<string, number>();

  run<T>(host: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const next = previous.then(async () => {
      const since = Date.now() - (this.last.get(host) ?? 0);
      if (since < delayMs) await sleep(delayMs - since);
      try {
        return await fn();
      } finally {
        this.last.set(host, Date.now());
      }
    });
    // Keep the chain alive even if one link rejects.
    this.tails.set(host, next.catch(() => undefined));
    return next;
  }
}

const queue = new HostQueue();

const robotsCache = new Map<string, { disallow: string[] }>();

async function loadRobots(origin: string): Promise<string[]> {
  const cached = robotsCache.get(origin);
  if (cached) return cached.disallow;

  const disallow: string[] = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": USER_AGENT } });
    if (res.ok) {
      const text = await res.text();
      // Only the rules for our own agent and for `*` are relevant.
      let inScope = false;
      for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        if (!line) continue;
        const [rawKey, ...rest] = line.split(":");
        const key = rawKey.trim().toLowerCase();
        const value = rest.join(":").trim();
        if (key === "user-agent") {
          const agent = value.toLowerCase();
          inScope = agent === "*" || agent.includes("docsearch");
        } else if (key === "disallow" && inScope && value) {
          disallow.push(value);
        }
      }
    }
  } catch {
    // No robots.txt (or unreachable) means no declared restrictions.
  }

  robotsCache.set(origin, { disallow });
  return disallow;
}

export function isAllowed(url: string, disallow: string[]): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  return !disallow.some((rule) => pathname.startsWith(rule));
}

export interface FetchOptions {
  /** Ignore the on-disk cache and refetch. */
  refresh?: boolean;
  /** Politeness delay for this host. */
  delayMs?: number;
  /** Use the cache even if the entry is older than this many ms. */
  maxAgeMs?: number;
}

export interface FetchResult {
  url: string;
  body: string;
  status: number;
  fromCache: boolean;
}

export async function fetchHtml(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const { refresh = false, delayMs = 120, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = opts;
  const host = new URL(url).host;

  const file = cachePath(url);
  if (!refresh && fs.existsSync(file)) {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < maxAgeMs) {
      return {
        url,
        body: fs.readFileSync(file, "utf8"),
        status: 200,
        fromCache: true,
      };
    }
  }

  return queue.run(host, delayMs, async () => {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain" },
      redirect: "follow",
    });

    if (!res.ok) {
      const err = new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }

    const body = await res.text();
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, body, "utf8");
    } catch {
      // Cache is an optimisation; a read-only disk should not fail the run.
    }
    return { url, body, status: res.status, fromCache: false };
  });
}

/** Bounded-concurrency map that preserves order and never rejects the batch. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

export async function checkRobots(url: string): Promise<boolean> {
  const origin = new URL(url).origin;
  return isAllowed(url, await loadRobots(origin));
}

export { USER_AGENT, CACHE_DIR };
