"use client";

import { useEffect, useState } from "react";

/**
 * Tracks which section is in view and exposes it to the caller.
 *
 * The section nav is a list of plain anchors, so without this nothing on screen
 * says where you are after clicking one - you either lose your place or scroll
 * back up to find out. The indicator reuses the left border the contents rail
 * already uses, so both read as the same instrument.
 *
 * IntersectionObserver rather than a scroll listener: no layout reads per frame,
 * and nothing happens at all while the page is idle.
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

    // A band across the upper viewport. A section is current once its heading
    // has crossed this line, which is roughly where the reader's eye is.
    const observer = new IntersectionObserver(
      (entries) => {
        const inBand = entries.filter((e) => e.isIntersecting);
        if (inBand.length === 0) return;
        // Sections do not overlap inside the band, but sort defensively so the
        // topmost wins if two briefly do.
        const topmost = inBand.sort(
          (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
        )[0];
        setActive(topmost.target.id);
      },
      { rootMargin: "-10% 0px -72% 0px", threshold: 0 },
    );

    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, [ids]);

  return active;
}