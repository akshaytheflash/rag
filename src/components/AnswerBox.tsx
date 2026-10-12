"use client";

import { useEffect, useRef, useState } from "react";
import type { SearchHit } from "@/lib/search";
import { parseFrames } from "@/lib/answer/sse";

type Phase = "waiting" | "streaming" | "done" | "failed";

interface AnswerBoxProps {
  question: string;
  hits: SearchHit[];
}

/** Matches the number of passages sent to the model - see /api/answer. */
const MAX_PASSAGES = 6;

/** Anchors the citation markers link to. Shared with the passage list. */
export const passageAnchor = (n: number) => `passage-${n}`;

/**
 * The generated answer, above the passages it came from.
 *
 * Placement is the argument: the answer is a reading aid, so it sits first and
 * short, with the passages it cites directly below, numbered to match. Each
 * citation marker is a link to the passage it refers to, so a claim can be
 * checked without leaving the page.
 *
 * Streaming matters more here than usual because the first token arrives only
 * after retrieval, the round trip and the model's reasoning - measured at
 * 350-490ms, and unbounded on a cold start. The loading state says which of
 * those is happening rather than showing an indeterminate spinner.
 */
export function AnswerBox({ question, hits }: AnswerBoxProps) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>("waiting");
  const [label, setLabel] = useState<string | null>(null);
  const [fellBack, setFellBack] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // The parent keys this component on the result set, so a new search mounts a
  // fresh instance with its state already correct. That is why nothing here
  // resets state on the way in: there is no previous answer to clear.
  useEffect(() => {
    if (!question || hits.length === 0) return;

    const controller = new AbortController();
    abortRef.current = controller;

    const passages = hits.slice(0, MAX_PASSAGES).map((hit, i) => ({
      index: i + 1,
      text: hit.text,
      sectionTitle: hit.sectionTitle,
      sourceLabel: hit.sourceLabel,
    }));

    (async () => {
      try {
        const res = await fetch("/api/answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, passages }),
          signal: controller.signal,
        });

        // Validation failures return ordinary JSON before any streaming begins,
        // so they arrive as a real status code rather than a stream error.
        if (!res.ok || !res.body) {
          const detail = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(detail?.error ?? "The answer service rejected the request.");
          setPhase("failed");
          return;
        }

        setPhase("streaming");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const { events, rest } = parseFrames(buffer);
          buffer = rest;

          for (const event of events) {
            if (controller.signal.aborted) return;

            if (event.type === "token") {
              setText((prev) => prev + event.text);
            } else if (event.type === "done") {
              setLabel(event.generatorLabel);
              setFellBack(event.fellBack);
              setPhase("done");
            } else if (event.type === "error") {
              setError(event.message);
              setPhase("failed");
            }
          }
        }

        // The stream ended without a `done` frame: the connection dropped.
        // Whatever arrived is still shown; only the attribution is missing.
        setPhase((p) => (p === "done" || p === "failed" ? p : "done"));
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "The answer stream failed.");
        setPhase("failed");
      }
    })();

    return () => controller.abort();
    // `hits` is a stable reference while a result set is displayed - it comes
    // off the search response and is only replaced when that response is.
  }, [question, hits]);

  const busy = phase === "waiting" || phase === "streaming";

  return (
    <section className="answerBox" aria-labelledby="answer-heading" aria-busy={busy}>
      <div className="answerHead">
        <h2 className="answerHeading" id="answer-heading">
          Answer
        </h2>

        {/* Phase is stated in words, not just shown as motion. A bar that
            animates forever tells a screen reader nothing, and everyone else
            only that something is happening. */}
        <span className="answerStatus" role="status">
          {phase === "waiting" ? "reading the passages" : null}
          {phase === "streaming" ? "writing" : null}
          {phase === "done" && label ? (
            <>
              written by {label}
              {fellBack ? ", after a fallback" : ""}
            </>
          ) : null}
          {phase === "failed" ? "unavailable" : null}
        </span>
      </div>

      {busy ? (
        <div className="answerProgress" aria-hidden="true">
          <span className="answerProgressFill" data-phase={phase} />
        </div>
      ) : null}

      {error ? (
        <p className="answerError">
          {error}
          {text ? " The partial answer below is all that arrived." : ""}
        </p>
      ) : null}

      <div className="answerBody">
        {text ? (
          <p className="answerText">
            {renderAnswer(text, hits)}
            {phase === "streaming" ? <span className="answerCaret" aria-hidden="true" /> : null}
          </p>
        ) : phase === "waiting" ? (
          <p className="answerPlaceholder">
            Reading {Math.min(hits.length, MAX_PASSAGES)} passages and composing an answer from them.
          </p>
        ) : null}
      </div>

      {text && phase !== "streaming" ? (
        <p className="answerDisclaimer">
          {label ? "Generated" : "Composed"} from the passages below by a language model, which can be
          wrong. Every numbered marker links to the passage it came from — open that, and the
          documentation page it points to, to check the claim rather than trust it.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Render the answer, turning citation markers into links.
 *
 * Full-width 【1】 is accepted alongside [1] because that is what gpt-oss-20b
 * actually emits. A marker becomes a link only when that passage exists - an
 * out-of-range citation would otherwise link to nothing, which is worse than
 * leaving the number as plain text.
 */
function renderAnswer(text: string, hits: SearchHit[]) {
  const parts = text.split(/([\[【]\s?\d{1,2}\s?[\]】])/g);
  const limit = Math.min(hits.length, MAX_PASSAGES);

  return parts.map((part, i) => {
    const match = part.match(/^[\[【]\s?(\d{1,2})\s?[\]】]$/);
    if (!match) return part;

    const n = Number(match[1]);
    if (n < 1 || n > limit) return part;

    return (
      <a
        key={i}
        className="answerCitation"
        href={`#${passageAnchor(n)}`}
        // Scroll the passage into view without changing the URL: the history
        // entry belongs to the search, not to a citation click.
        onClick={(event) => {
          event.preventDefault();
          document
            .getElementById(passageAnchor(n))
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }}
        title={hits[n - 1]?.sectionTitle ?? `Passage ${n}`}
      >
        {n}
      </a>
    );
  });
}