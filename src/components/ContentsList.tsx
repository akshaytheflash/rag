"use client";

import type { CorpusStat } from "@/lib/search";

interface ContentsListProps {
  sources: CorpusStat[];
  totalPassages: number;
  active: string;
  onSelect: (source: "all" | string) => void;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

/**
 * The table of contents for the three manuals. The volumes carry the passage
 * count that is actually in the index, so the landing page reports what has
 * been retrieved rather than what the documentation nominally contains.
 */
export function ContentsList({ sources, totalPassages, active, onSelect }: ContentsListProps) {
  return (
    <>
      <h2 className="contentsHeading" id="contents-heading">
        Contents
      </h2>
      <ul className="contentsList" aria-labelledby="contents-heading">
        <li>
          <button
            type="button"
            className={`contentsItem ${active === "all" ? "contentsItemActive" : ""}`}
            aria-pressed={active === "all"}
            onClick={() => onSelect("all")}
            style={{ color: "var(--ink)" }}
          >
            <span className="contentsItemLabel">
              <span className="contentsItemName">All manuals</span>
            </span>
            <span className="contentsItemMeta">
              {plural(totalPassages, "passage", "passages")}
            </span>
          </button>
        </li>

        {sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className={`contentsItem ${active === source.id ? "contentsItemActive" : ""}`}
              aria-pressed={active === source.id}
              onClick={() => onSelect(source.id)}
              style={{ color: source.color }}
            >
              <span className="contentsItemLabel">
                <span className="contentsItemName">{source.name}</span>
              </span>
              <span className="contentsItemMeta">
                {source.version ? `${source.version} · ` : ""}
                {plural(source.passages, "passage", "passages")}
              </span>
            </button>
          </li>
        ))}
      </ul>

      <p className="contentsNote">
        Passages are copied from the published documentation and linked back to the page they came
        from. Nothing here is generated.
      </p>
    </>
  );
}
