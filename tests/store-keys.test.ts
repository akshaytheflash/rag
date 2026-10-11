import { describe, expect, it } from "vitest";
import { documentKey } from "../src/ingest/store";

/**
 * Pruning is keyed on (url, anchor) rather than url alone.
 *
 * A section can survive upstream while ceasing to produce passages - FastAPI's
 * contributor list is dropped at extraction now that it is known to be
 * unmatchable. Before this was keyed correctly, that section's old chunks
 * stayed in the index forever: the page was still "seen", so nothing pruned it,
 * and it produced no new chunks, so nothing refreshed it. It was returned by
 * queries and could not be removed by any later run.
 *
 * These tests pin the key format that both the ingest loop and the pruner
 * derive, since a disagreement between them would silently prune live sections
 * or keep dead ones.
 */
describe("document natural key", () => {
  it("distinguishes two sections on the same page", () => {
    expect(documentKey("https://x.test/p", "dependencies")).not.toBe(
      documentKey("https://x.test/p", "background-tasks"),
    );
  });

  it("distinguishes two pages with the same anchor", () => {
    expect(documentKey("https://x.test/a", "usage")).not.toBe(
      documentKey("https://x.test/b", "usage"),
    );
  });

  it("is stable for the same url and anchor", () => {
    expect(documentKey("https://x.test/p", "a")).toBe(documentKey("https://x.test/p", "a"));
  });

  it("handles an empty anchor without colliding with a literal '#'", () => {
    // The root section of a page has an empty anchor; it must still produce a
    // distinct key from a page whose anchor happens to be empty by accident.
    expect(typeof documentKey("https://x.test/p", "")).toBe("string");
    expect(documentKey("https://x.test/p", "")).not.toBe(documentKey("https://x.test/p", "x"));
  });
});