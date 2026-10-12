/**
 * Section order for /how-it-works.
 *
 * Kept in its own module because two files need it - the page, which owns the
 * sections, and the rail, which lists them. Duplicating the list is how a nav
 * entry ends up pointing at an id that no longer exists, or a section ends up
 * with no way to be reached. Neither failure announces itself; both are silent.
 */
export interface Section {
  id: string;
  label: string;
}

export const SECTIONS: Section[] = [
  { id: "claim", label: "The claim" },
  { id: "pipeline", label: "The pipeline" },
  { id: "retrieval", label: "Two retrievers" },
  { id: "bug", label: "A bug worth reading about" },
  { id: "threshold", label: "Choosing the threshold" },
  { id: "performance", label: "Performance" },
  { id: "corpus", label: "What is indexed" },
  { id: "storage", label: "What it costs" },
  { id: "limits", label: "Limits and trade-offs" },
];