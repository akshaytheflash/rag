"use client";

import type { CorpusStat, SearchResponse } from "@/lib/search";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ContentsList } from "./ContentsList";
import { ResultList } from "./ResultList";
import { ThemeToggle } from "./ThemeToggle";

type Status = "idle" | "loading" | "done" | "error";

interface DocSearchAppProps {
  sources: CorpusStat[];
  totalPassages: number;
}

const EXAMPLES: Record<string, string> = {
  all: "How do I create a dependency in FastAPI?",
  python: "How do I write a generator that yields values?",
  fastapi: "How do I return a file response from a route?",
  postgresql: "How do I use a window function with OVER?",
};

const VALID_SOURCES = new Set(["all", "python", "fastapi", "postgresql"]);

export function DocSearchApp({ sources, totalPassages }: DocSearchAppProps) {
  // Reading the initial state from the URL keeps a result set shareable, and
  // deriving it during render avoids a mount-time setState.
  const searchParams = useSearchParams();
  const initialQuery = searchParams.get("q") ?? "";
  const initialSourceParam = searchParams.get("s") ?? "all";
  const initialSource = VALID_SOURCES.has(initialSourceParam) ? initialSourceParam : "all";

  const [query, setQuery] = useState(initialQuery);
  const [source, setSource] = useState(initialSource);
  const [status, setStatus] = useState<Status>(initialQuery ? "loading" : "idle");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const booted = useRef(false);

  const runSearch = useCallback(async (term: string, filter: string) => {
    const trimmed = term.trim();
    if (!trimmed) {
      setStatus("idle");
      setResponse(null);
      setError(null);
      return;
    }

    const id = ++requestId.current;
    setStatus("loading");
    setError(null);

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, source: filter }),
      });

      const body: unknown = await res.json();

      if (id !== requestId.current) return; // a newer search superseded this one

      if (!res.ok) {
        const message =
          typeof body === "object" && body && "error" in body
            ? String((body as { error: unknown }).error)
            : "The search could not be completed.";
        setError(message);
        setStatus("error");
        setResponse(null);
        return;
      }

      setResponse(body as SearchResponse);
      setStatus("done");
    } catch {
      if (id !== requestId.current) return;
      setError("Could not reach the search service. Check your connection and try again.");
      setStatus("error");
      setResponse(null);
    }
  }, []);

  // Run the shared-URL search once the page has painted, so the contents and
  // filters are visible before the loading state replaces them.
  useEffect(() => {
    if (booted.current || !initialQuery) return;
    booted.current = true;
    const handle = window.setTimeout(() => {
      void runSearch(initialQuery, initialSource);
    }, 0);
    return () => window.clearTimeout(handle);
    // Mount only - the URL is read once, into initial state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncUrl = useCallback((term: string, filter: string) => {
    const params = new URLSearchParams();
    if (term.trim()) params.set("q", term.trim());
    if (filter !== "all") params.set("s", filter);
    const next = params.toString();
    window.history.replaceState(null, "", next ? `?${next}` : window.location.pathname);
  }, []);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    syncUrl(trimmed, source);
    void runSearch(trimmed, source);
  };

  const onSelectSource = (next: string) => {
    setSource(next);
    syncUrl(query, next);
    if (query.trim()) void runSearch(query, next);
  };

  const onUseExample = (example: string) => {
    setQuery(example);
    syncUrl(example, source);
    void runSearch(example, source);
    inputRef.current?.focus();
  };

  const example = EXAMPLES[source] ?? EXAMPLES.all;
  const hits = response?.results ?? [];

  return (
    <div className="shell">
      <aside className="rail">
        {/* Top-left, above the wordmark: the first control on the page. */}
        <ThemeToggle />

        <h1 className="wordmark">
          <Link href="/" className="wordmarkLink">
            DocSearch
          </Link>
        </h1>
        <p className="wordmarkSub">
          Semantic search over three manuals. Retrieval only.
        </p>

        <ContentsList
          sources={sources}
          totalPassages={totalPassages}
          active={source}
          onSelect={onSelectSource}
        />

        <p className="contentsAbout">
          <Link href="/how-it-works" className="contentsAboutLink">
            How this works
          </Link>
        </p>
      </aside>

      <main className="main">
        <section className="searchRegion" id="search">
          <h2 className="searchPrompt">
            Find the passage that answers it
            <span className="searchPromptSub">
              Your question is matched against every indexed passage. What comes back is the
              documentation&rsquo;s own text, linked to the page it was taken from.
            </span>
          </h2>

          <form className="searchForm" onSubmit={onSubmit} role="search">
            <label className="srOnly" htmlFor="search-input">
              Search the Python, FastAPI and PostgreSQL documentation
            </label>
            <input
              id="search-input"
              ref={inputRef}
              className="searchInput"
              type="search"
              name="q"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={example}
              autoComplete="off"
              spellCheck={false}
              maxLength={400}
            />
            <button className="searchSubmit" type="submit" disabled={status === "loading"}>
              {status === "loading" ? "Searching" : "Search"}
            </button>
          </form>

          <div className="filters">
            <span className="filtersLabel" id="filter-label">
              Manual
            </span>
            <div className="filtersGroup" role="group" aria-labelledby="filter-label">
              <FilterButton
                label="All"
                active={source === "all"}
                color="var(--ink-2)"
                onClick={() => onSelectSource("all")}
              />
              {sources.map((s) => (
                <FilterButton
                  key={s.id}
                  label={s.name}
                  active={source === s.id}
                  color={s.color}
                  onClick={() => onSelectSource(s.id)}
                />
              ))}
            </div>
          </div>
        </section>

        {/* Announced to assistive tech as a short summary. The result list
            itself is not a live region: replacing its entire contents would
            otherwise make a screen reader read every passage aloud. */}
        <p className="srOnly" role="status">
          {status === "loading"
            ? "Searching"
            : status === "error"
              ? "The search did not run."
              : status === "done" && response
                ? response.results.length === 0
                  ? `No passages found for ${response.query}.`
                  : `${response.results.length} passages found.`
                : ""}
        </p>

        <div aria-busy={status === "loading"}>
          {status === "loading" ? (
            <div className="loadingRow">
              <span className="loadingBar">
                <span className="loadingBarFill" />
              </span>
              <span>Matching your question against the index…</span>
            </div>
          ) : null}

          {status === "error" && error ? (
            <section className="stateBlock">
              <h2 className="stateHeading">The search did not run</h2>
              <p className="stateError">
                {error}
                <span className="stateErrorCode">
                  If this keeps happening the index database may be starting up from cold.
                </span>
              </p>
              <div className="stateActions">
                <button
                  type="button"
                  className="stateLink"
                  onClick={() => void runSearch(query, source)}
                >
                  Try again
                </button>
              </div>
            </section>
          ) : null}

          {status === "done" && response && hits.length > 0 ? (
            <>
              <ResultList hits={hits} query={response.query} />
              <p className="disclaimer">
                Similarity scores rank passages by how close they sit to your question in embedding
                space. A high score means the wording is similar, not that the passage is a correct
                or complete answer. Open the source page to read it in context.
              </p>
            </>
          ) : null}

          {status === "done" && response && hits.length === 0 ? (
            <section className="stateBlock">
              <h2 className="stateHeading">No passage was close enough</h2>
              <p className="stateText">
                Nothing in the {source === "all" ? "indexed manuals" : sources.find((s) => s.id === source)?.name ?? "index"} scored above{" "}
                {response.filters.threshold.toFixed(2)} against &ldquo;{response.query}&rdquo;.
                Semantic search matches wording as well as meaning, so a more specific phrasing — or
                the API name you are looking for — usually works better.
              </p>
              <div className="stateActions">
                {source !== "all" ? (
                  <button type="button" className="stateLink" onClick={() => onSelectSource("all")}>
                    Search all manuals instead
                  </button>
                ) : null}
                <button
                  type="button"
                  className="stateLink"
                  onClick={() => onUseExample(example)}
                >
                  Run an example question
                </button>
              </div>
              <ul className="suggestionList">
                {Object.values(EXAMPLES).map((text) => (
                  <li className="suggestionItem" key={text}>
                    <button
                      type="button"
                      className="suggestionButton"
                      onClick={() => onUseExample(text)}
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {status === "idle" ? (
            <section className="stateBlock">
              <h2 className="stateHeading">Ask in your own words</h2>
              <p className="stateText">
                {totalPassages > 0
                  ? `${totalPassages.toLocaleString()} passages from the official Python, FastAPI and PostgreSQL documentation are indexed. Type a question and the closest matches come back in order.`
                  : "The index is empty. Run the ingestion pipeline locally with npm run ingest to populate it."}
              </p>
              <ul className="suggestionList">
                {Object.values(EXAMPLES).map((text) => (
                  <li className="suggestionItem" key={text}>
                    <button
                      type="button"
                      className="suggestionButton"
                      onClick={() => onUseExample(text)}
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function FilterButton({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`filterButton ${active ? "filterButtonActive" : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      <span className="filterSwatch" style={{ background: color }} aria-hidden="true" />
      {label}
    </button>
  );
}
