"use client";

import type { SearchHit } from "@/lib/search";
import { Passage } from "./Passage";

interface ResultListProps {
  hits: SearchHit[];
  query: string;
}

/**
 * A ranked index. The number in the margin is the rank, which is a real
 * ordering here. The heading is the one link to the source; the URL below it
 * is a locator, the way a page number is in a book's index.
 */
export function ResultList({ hits, query }: ResultListProps) {
  return (
    <>
      <div className="resultsHead">
        <h2 className="resultsCount">
          {hits.length} {hits.length === 1 ? "passage" : "passages"}
        </h2>
        <p className="resultsMeta">ranked by fused relevance to &ldquo;{query}&rdquo;</p>
      </div>

      <ol className="resultsList">
        {hits.map((hit, index) => {
          // The last heading is the entry itself, shown as the title, so the
          // breadcrumb is whatever sits above it.
          const ancestors = hit.headingPath.slice(0, -1);
          const pageTitle = hit.title !== hit.sectionTitle ? hit.title : null;
          const lexicalOnly = hit.similarity === null;

          return (
            <li
              key={hit.chunkId}
              className="resultItem"
              style={{
                ["--spine" as string]: hit.sourceColor,
                // Drives the stagger below. Capped so the last result never
                // waits long enough to feel broken.
                ["--stagger" as string]: `${Math.min(index, 6) * 45}ms`,
              }}
            >
              <span className="resultRank" aria-hidden="true">
                {index + 1}
              </span>

              <div className="resultBody">
                <p className="resultSource">
                  <span className="resultSourceName">{hit.sourceLabel}</span>
                  {hit.version ? <span className="resultSourceVersion">v{hit.version}</span> : null}
                </p>

                <h3 className="resultTitle">
                  <a
                    className="resultTitleLink"
                    href={hit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {hit.sectionTitle}
                  </a>
                </h3>

                {ancestors.length > 0 ? (
                  <p className="resultPath">
                    {ancestors.map((part, i) => (
                      <span key={`${part}-${i}`}>
                        {i > 0 ? <span className="resultPathSep">›</span> : null}
                        {part}
                      </span>
                    ))}
                  </p>
                ) : null}

                {pageTitle ? <p className="resultPath">{pageTitle}</p> : null}

                <p className="resultUrl">{hit.url.replace(/^https?:\/\//, "")}</p>

                <p className="scoreRow">
                  {/*
                    Says which retriever found the passage rather than showing a
                    single opaque number. "Both" is the strongest signal here:
                    the wording matched and the meaning matched. A lexical-only
                    hit has no similarity at all, and reporting 0.000 would read
                    as a measurement when nothing was measured.
                  */}
                  <span className="scoreLabel">matched by</span>
                  <span className="matchRow">
                    {hit.matchedBy.includes("semantic") ? (
                      <span className="matchTag">meaning</span>
                    ) : null}
                    {hit.matchedBy.includes("lexical") ? (
                      <span className="matchTag">wording</span>
                    ) : null}
                  </span>
                  <span className="scoreValue">
                    {lexicalOnly
                      ? "exact terms"
                      : `${hit.matchedBy.length === 2 ? "both" : "similarity"} ${hit.similarity!.toFixed(3)}`}
                  </span>
                </p>

                <Passage hit={hit} />
              </div>
            </li>
          );
        })}
      </ol>
    </>
  );
}
