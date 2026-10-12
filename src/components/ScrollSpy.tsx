"use client";

import { useEffect, useState } from "react";

/** Distance below the viewport top at which a section counts as current. */
export const ACTIVE_LINE_PX = 120;

/**
 * Which section is the reader in, given where each one's top currently sits.
 *
 * The rule is "the last section whose top has passed the line", walked in
 * document order. It does not depend on scroll direction, on which elements
 * the browser happened to report, or on any ordering between two sections that
 * are briefly both eligible - which is exactly the ambiguity that left the
 * indicator one section behind when jumping down the page.
 *
 * Exported so the behaviour is tested directly rather than through a synthetic
 * scroll in a browser, which is how it shipped broken in the first place.
 */
export function pickActiveSection(
  tops: { id: string; top: number }[],
  linePx: number,
  atBottom: boolean,
): string | null {
  if (tops.length === 0) return null;
  if (atBottom) return tops[tops.length - 1].id;

  let current = tops[0].id;
  for (const { id, top } of tops) {
    if (top <= linePx) current = id;
  }
  return current;
}

/**
 * Tracks which section is in view and exposes it to the caller.
 *
 * The section nav is a list of plain anchors, so without this nothing on screen
 * says where you are after clicking one - you either lose your place or scroll
 * back up to find out. The indicator reuses the left border the contents rail
 * already uses, so both read as the same instrument.
 *
 * Deliberately not animated. Animating the highlight would mean it moves
 * constantly while scrolling, which is motion nobody asked for - it should
 * change when the section you are reading changes, and not otherwise.
 */
export function useActiveSection(ids: string[]): string | null {
  // Seeded from the URL during render rather than in an effect: a page opened
  // at a hash is then correct on the first paint, instead of briefly showing
  // the wrong section and correcting a frame later.
  const [active, setActive] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.replace("#", "");
    return hash && ids.includes(hash) ? hash : null;
  });

  useEffect(() => {
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);

    if (sections.length === 0) return;

    let frame = 0;

    const compute = () => {
      frame = 0;

      // At the very bottom the last section may never reach the line, because
      // the page runs out of scroll. The bottom of the document is that
      // section, so say so rather than reporting the one above it.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;

      const current = pickActiveSection(
        sections.map((s) => ({ id: s.id, top: s.getBoundingClientRect().top })),
        ACTIVE_LINE_PX,
        atBottom,
      );

      if (current !== null) setActive((previous) => (previous === current ? previous : current));
    };

    // Coalesced to one computation per frame. A scroll handler that reads layout
    // has to be passive and throttled; the rAF does the second part, and nine
    // cached elements make the reads trivial.
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(compute);
    };

    compute();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [ids]);

  return active;
}