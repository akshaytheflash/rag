"use client";

import { useId, useState } from "react";
import type { SearchHit } from "@/lib/search";

const PREVIEW_CHARS = 260;

interface PassageProps {
  hit: SearchHit;
}

/**
 * The retrieved text, verbatim. Long passages start collapsed so the results
 * list stays scannable; the full text is always one keystroke away and is
 * never truncated in the data itself.
 */
export function Passage({ hit }: PassageProps) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  const isLong = hit.text.length > PREVIEW_CHARS;
  const shown = isLong && !expanded ? `${hit.text.slice(0, PREVIEW_CHARS).trimEnd()}…` : hit.text;

  return (
    <div className="passage">
      {isLong ? (
        <>
          <button
            type="button"
            className="passageToggle"
            aria-expanded={expanded}
            aria-controls={regionId}
            onClick={() => setExpanded((v) => !v)}
          >
            {/* The mark is the indicator, not a label: it shows which way the
                passage will move. Rotating it is the one motion that carries
                information here. */}
            <span className="passageCaret" aria-hidden="true">
              <svg viewBox="0 0 10 10">
                <path d="M2.5 3.5 L5 6 L7.5 3.5" />
              </svg>
            </span>
            <span className="passageToggleMark">{expanded ? "Hide passage" : "Show full passage"}</span>
            <span className="passageToggleMark">
              {Math.round(hit.text.length / 4).toLocaleString()} tokens
            </span>
          </button>
          {/* The region animates open rather than appearing instantly, so it is
              obvious that the text below the fold belongs to this result. */}
          <div
            className="passageBodyWrap"
            id={regionId}
            data-expanded={expanded ? "true" : "false"}
          >
            <div className="passageBody">{shown}</div>
          </div>
        </>
      ) : (
        <div className="passageBodyWrap" data-expanded="true">
          <div className="passageBody">{hit.text}</div>
        </div>
      )}
    </div>
  );
}
