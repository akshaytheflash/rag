import { describe, expect, it } from "vitest";
import { pickActiveSection, ACTIVE_LINE_PX } from "../src/components/ScrollSpy";

const LINE = ACTIVE_LINE_PX;

/**
 * Regression guard for a scroll-spy that reported the section *above* the one
 * being read, but only when moving down the page.
 *
 * The first version used an IntersectionObserver and took the topmost reported
 * section that was intersecting. An observer only reports elements whose
 * intersection state changed since the previous callback, so that is the
 * topmost of a partial set, not of everything on screen. When jumping down to a
 * section, the one above and the one below are both inside the band at the same
 * moment, and whichever arrived first in the callback won. Moving up reported
 * them in the opposite order, which is why only one direction was broken.
 *
 * The fix walks the sections in document order instead. These tests pin the
 * rule down directly, because the bug was invisible to the eye - it needed a
 * scroll event in a real browser to produce, and it did not look wrong while
 * happening.
 */
describe("pickActiveSection", () => {
  /** The nine sections on /how-it-works, in document order. */
  const ids = [
    "claim",
    "pipeline",
    "retrieval",
    "bug",
    "threshold",
    "performance",
    "corpus",
    "storage",
    "limits",
  ];

  /** Build tops for a given scroll position of a 900px-tall page. */
  function at(sectionHeights: number[], viewportTop: number) {
    const tops: { id: string; top: number }[] = [];
    let documentTop = 0;
    for (let i = 0; i < sectionHeights.length; i++) {
      tops.push({ id: ids[i], top: documentTop - viewportTop });
      documentTop += sectionHeights[i];
    }
    return tops;
  }

  const heights = [600, 700, 800, 900, 1000, 700, 800, 700, 600];

  /** Viewport offset such that a given section's top sits at `topInViewport`. */
  function scrollFor(index: number, topInViewport: number) {
    let before = 0;
    for (let i = 0; i < index; i++) before += heights[i];
    return before - topInViewport;
  }

  it("reports the section whose top has just passed the line", () => {
    const tops = at(heights, scrollFor(0, 20));
    expect(pickActiveSection(tops, LINE, false)).toBe("claim");
  });

  it("reports the first section before any has crossed the line", () => {
    const tops = at(heights, 0);
    expect(pickActiveSection(tops, LINE, false)).toBe("claim");
  });

  /**
   * The reported bug, exactly: landing on `threshold` leaves `bug` above the
   * line and `threshold` at the very top of the viewport. Both are eligible at
   * once, and the answer must be the later one.
   */
  it("reports the destination when jumping down, not the section above it", () => {
    const tops = at(heights, scrollFor(4, 24));
    expect(pickActiveSection(tops, LINE, false)).toBe("threshold");
  });

  it("reports the destination when jumping up, not the section below it", () => {
    const tops = at(heights, scrollFor(2, 24));
    expect(pickActiveSection(tops, LINE, false)).toBe("retrieval");
  });

  it("agrees in both directions at every section boundary", () => {
    for (let i = 0; i < ids.length; i++) {
      const tops = at(heights, scrollFor(i, 24));
      expect(pickActiveSection(tops, LINE, false)).toBe(ids[i]);
    }
  });

  it("holds while scrolling continuously through a boundary", () => {
    // Walk from deep in `bug` into `threshold`, one pixel at a time. The
    // indicator must flip exactly once, and never report `bug` after `threshold`
    // has been reached.
    // Start where `bug` is active: bug's top is above the line, threshold's below.
    // End with threshold at the top of the viewport. Scrolling down the page
    // moves the viewport offset down, so v decreases.
    const from = scrollFor(4, LINE + 40);
    const to = scrollFor(4, 0);
    expect(pickActiveSection(at(heights, from), LINE, false)).toBe("bug");
    expect(to).toBeGreaterThan(from);

    let flipped = false;
    for (let v = from; v <= to; v += 1) {
      const active = pickActiveSection(at(heights, v), LINE, false);
      if (active === "threshold") flipped = true;
      if (flipped) expect(active).toBe("threshold");
    }
    expect(flipped).toBe(true);
  });

  it("does not report a section that has not been reached yet", () => {
    const tops = at(heights, scrollFor(4, 24));
    expect(pickActiveSection(tops, LINE, false)).not.toBe("performance");
  });

  it("reports the last section at the bottom of the page", () => {
    // The final section may never cross the line, because the page runs out of
    // scroll before it does.
    // Near the bottom but not at it: `limits` has crossed the line, so the
    // ordinary rule already reports it.
    const nearBottom = at(heights, 6700);
    expect(pickActiveSection(nearBottom, LINE, false)).toBe("limits");
    expect(pickActiveSection(nearBottom, LINE, true)).toBe("limits");

    // A short final section that the page runs out of scroll before it can
    // reach the line. Only the atBottom branch can get this right.
    const stubby = [
      { id: "a", top: -900 },
      { id: "b", top: -100 },
      { id: "c", top: 700 },
    ];
    expect(pickActiveSection(stubby, LINE, false)).toBe("b");
    expect(pickActiveSection(stubby, LINE, true)).toBe("c");
  });

  it("returns null when there are no sections", () => {
    expect(pickActiveSection([], LINE, false)).toBeNull();
  });
});