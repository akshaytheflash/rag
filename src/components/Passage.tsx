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
            <span className="passageToggleMark">{expanded ? "Hide passage" : "Show full passage"}</span>
            <span className="passageToggleMark">
              {Math.round(hit.text.length / 4).toLocaleString()} tokens
            </span>
          </button>
          <div className="passageBody" id={regionId}>
            {shown}
          </div>
        </>
      ) : (
        <div className="passageBody">{hit.text}</div>
      )}
    </div>
  );
}
