import type { Graph, WorkflowDocument, WorkflowEvidence, WorkflowReference, WorkflowStep } from "skills-viewer";
import { libraryColor } from "./data.ts";

export interface WorkflowCardData extends Record<string, unknown> {
  label: string;
  library: string;
  color: number;
  kind: string;
  number?: string;
  description?: string;
  document?: string;
  expanded?: boolean;
  evidence?: WorkflowEvidence;
  cycle?: boolean;
}
export interface WorkflowView {
  nodes: { id: string; data: WorkflowCardData }[];
  edges: {
    id: string;
    source: string;
    target: string;
    label: string;
    kind: "order" | "reference" | "repeat" | "recursive";
    evidence?: WorkflowEvidence;
  }[];
  truncated: boolean;
}

/** Occurrences have separate identities; a cycle points back to its ancestor, never recurses forever. */
export function buildWorkflow(
  graph: Graph,
  root: string,
  expanded: Set<string>,
  showFiles = true,
  limit = 250,
): WorkflowView {
  const docs = new Map((graph.workflows ?? []).map((d) => [d.id, d]));
  const skills = new Map(graph.nodes.map((s) => [s.id, s]));
  const view: WorkflowView = { nodes: [], edges: [], truncated: false };
  const color = (doc: WorkflowDocument) => {
    const skill = skills.get(doc.owner);
    const library = skill?.library ?? skill?.plugin?.replace(/^plugin:/, "") ?? "Workspace";
    return { library, color: libraryColor(library) };
  };
  const add = (id: string, data: WorkflowCardData) => {
    if (view.nodes.length >= limit) {
      view.truncated = true;
      return false;
    }
    view.nodes.push({ id, data });
    return true;
  };
  const edge = (
    source: string,
    target: string,
    label: string,
    kind: WorkflowView["edges"][number]["kind"],
    evidence?: WorkflowEvidence,
  ) => {
    if (!view.nodes.some((n) => n.id === source) || !view.nodes.some((n) => n.id === target)) return;
    view.edges.push({ id: `we${view.edges.length}`, source, target, label, kind, evidence });
  };
  const reference = (ref: WorkflowReference, parent: string, ancestors: Map<string, string>, index: number) => {
    const doc = docs.get(ref.target);
    if (!doc || (!showFiles && doc.kind !== "skill")) return;
    const prior = ancestors.get(doc.id);
    if (prior) {
      edge(parent, prior, "recursive reference", "recursive", ref.evidence);
      return;
    }
    const id = `${parent}/ref${index}`;
    visit(doc, id, ancestors, ref.evidence);
    edge(
      parent,
      id,
      ref.kind === "file" || ref.kind === "directory" ? "references" : ref.kind,
      "reference",
      ref.evidence,
    );
  };
  const step = (s: WorkflowStep, doc: WorkflowDocument, id: string, ancestors: Map<string, string>) => {
    if (
      !add(id, { label: s.label, ...color(doc), kind: s.branchKind ?? "step", number: s.number, evidence: s.evidence })
    )
      return;
    s.references.forEach((ref, i) => reference(ref, id, ancestors, i));
    if (s.repeat) edge(id, id, s.repeat, "repeat", s.evidence);
  };
  function visit(doc: WorkflowDocument, id: string, ancestors: Map<string, string>, evidence?: WorkflowEvidence) {
    const open = expanded.has(doc.id);
    if (
      !add(id, {
        label: doc.label,
        ...color(doc),
        kind: doc.kind,
        document: doc.id,
        expanded: open,
        evidence,
        description: doc.kind === "skill" ? skills.get(doc.id)?.description : doc.file,
      })
    )
      return;
    if (!open) return;
    const next = new Map(ancestors).set(doc.id, id);
    const covered = new Set<string>();
    doc.sequences.forEach((sequence, si) => {
      let previous = id;
      sequence.forEach((s, i) => {
        const sid = `${id}/sequence${si}/step${i}`;
        step(s, doc, sid, next);
        edge(previous, sid, i === 0 ? "listed steps" : "next", "order", s.evidence);
        previous = sid;
        for (const ref of s.references) covered.add(`${ref.target}:${ref.evidence.line}`);
        if (s.branches?.length) {
          const branches: string[] = [];
          s.branches.forEach((b, bi) => {
            const bid = `${sid}/branch${bi}`;
            step(b, doc, bid, next);
            edge(sid, bid, s.branchKind === "parallel" ? "parallel" : "one option", "order", b.evidence);
            branches.push(bid);
            for (const ref of b.references) covered.add(`${ref.target}:${ref.evidence.line}`);
          });
          if (s.join && s.branchKind === "parallel") {
            const jid = `${sid}/join`;
            add(jid, { label: "Wait for all", ...color(doc), kind: "join", evidence: s.joinEvidence });
            for (const bid of branches) edge(bid, jid, "complete", "order", s.joinEvidence);
            previous = jid;
          }
        }
      });
    });
    const unique = new Set<string>();
    doc.references.forEach((ref, i) => {
      if (covered.has(`${ref.target}:${ref.evidence.line}`) || unique.has(ref.target)) return;
      unique.add(ref.target);
      reference(ref, id, next, i);
    });
    // A referenced directory can be expanded as an inventory, never as an execution sequence.
    if (doc.kind === "directory" && showFiles)
      for (const [i, child] of doc.children.entries()) {
        const target = docs.get(child);
        if (!target) continue;
        const prior = next.get(target.id);
        if (prior) {
          edge(id, prior, "contains ancestor", "reference");
          continue;
        }
        const cid = `${id}/file${i}`;
        visit(target, cid, next);
        edge(id, cid, "contains", "reference");
      }
  }
  const doc = docs.get(root);
  if (doc) visit(doc, "root", new Map());
  return view;
}
