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
        <p className="resultsMeta">ranked by cosine similarity to &ldquo;{query}&rdquo;</p>
      </div>

      <ol className="resultsList">
        {hits.map((hit, index) => {
          // The last heading is the entry itself, shown as the title, so the
          // breadcrumb is whatever sits above it.
          const ancestors = hit.headingPath.slice(0, -1);
          const score = Math.max(0, Math.min(1, hit.similarity));
          const pageTitle = hit.title !== hit.sectionTitle ? hit.title : null;

          return (
            <li
              key={hit.chunkId}
              className="resultItem"
              style={{ ["--spine" as string]: hit.sourceColor }}
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
                  <span className="scoreLabel">similarity</span>
                  <span className="scoreBar">
                    <span className="scoreFill" style={{ width: `${(score * 100).toFixed(1)}%` }} />
                  </span>
                  <span className="scoreValue">{score.toFixed(3)}</span>
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
