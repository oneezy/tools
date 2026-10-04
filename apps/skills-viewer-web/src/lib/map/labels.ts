import type { EdgeType } from "skills-viewer";

export const EDGE_TYPES: { key: EdgeType; label: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "suggests", label: "Suggests" },
  { key: "prerequisite", label: "Needs first" },
  { key: "reference", label: "Mentions" },
];

/** markdown emphasis and code ticks read as noise in a one-line snippet */
export const plain = (s: string) => s.replace(/[*`]/g, "");
