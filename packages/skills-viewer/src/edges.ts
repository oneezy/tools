import type { ParsedSkill } from "./parse.js";
import type { Edge, EdgeType, Evidence, Flow, FlowKind, Mode, UnresolvedMention } from "./types.js";

/** One place in a SKILL.md body that names another skill. */
export interface Mention {
  source: string;
  /** resolved skill id, or null when the name is not in the library */
  target: string | null;
  rawName: string;
  line: number;
  col: number;
  end: number;
  pattern: string;
  type: EdgeType;
}

const NAME = "[a-z](?:[a-z0-9-]*[a-z0-9])?";
const STOP = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "each",
  "every",
  "other",
  "whole",
  "same",
  "any",
  "one",
  "engineering",
  "new",
  "first",
  "next",
  "right",
  "own",
  "wrong",
]);

/** Ordered: earlier detectors consume their span so later ones cannot double-count it. */
const DETECTORS: Array<{ pattern: string; re: RegExp; group: number }> = [
  { pattern: "skill-tool", re: /Skill tool[^.\n]{0,160}/gi, group: 0 }, // handled specially: all "quoted" names inside
  { pattern: "link", re: new RegExp(`\\]\\([^)]*?(${NAME})/SKILL\\.md[^)]*\\)`, "gi"), group: 1 },
  { pattern: "skill-uri", re: new RegExp(`skill://(${NAME})`, "gi"), group: 1 },
  {
    pattern: "prose",
    re: new RegExp(
      `\\b(?:the|call|calls|use|uses|invoke|invokes|run|runs|via|with|through)\\s+\`?/?(${NAME})\`?\\s+skill\\b`,
      "gi",
    ),
    group: 1,
  },
  { pattern: "slash", re: new RegExp(`(?<![\\w/.:~\\\\-])/(${NAME})(?![\\w/.-])`, "g"), group: 1 },
  { pattern: "dollar", re: new RegExp(`(?<![\\w])\\$(${NAME})(?![\\w/.-])`, "g"), group: 1 },
  { pattern: "at", re: new RegExp(`(?<![\\w.@/])@(${NAME})(?![\\w/.@-])`, "g"), group: 1 },
  { pattern: "backtick", re: new RegExp(`\`(${NAME})\``, "g"), group: 1 },
];

const PREREQ =
  /\b(if not,? (?:tell|ask|run)|if (?:it |that |this |they )?(?:has ?n[o']t|hasn't|isn't|is not|are not|aren't|have ?n[o']t|haven't)\b|not been (?:provided|run|set up|installed|done)|missing|prerequisite|prereq|before (?:you|we|your|any|the first|starting|continuing)|run .{0,25}\bfirst\b|requires? (?:running|that you run|you to run)|should have been|must (?:have|already|first)|already (?:run|ran|been))\b/i;
const PREREQ_AFTER = /^\W{0,3}(?:first|before|beforehand)\b/i;
const SUGGEST =
  /\b(tell the (?:user|human)|ask the (?:user|human)|suggest|recommend|user (?:can|may|should|might|will|then)|human (?:can|may|should)|offer|consider|optionally|may want|hand ?off to|hand-off to|when (?:done|finished)|afterwards|next step|follow ?up|the user (?:runs|invokes))\b/i;
/** the mention is the subject of a sentence that describes it: "/x sharpens the idea", "/x is for ..." */
const DESCRIBES =
  /^\W{0,6}(?:is|are|was|does|sharpens|works|comes|runs|moves|builds|turns|helps|handles|takes|learns|delegates|answers|makes|gives|lets|reads|writes|records|keeps|finds|sets|guides|walks|reviews|plans|charts|resolves|investigates|generates|creates|produces|migrates|scaffolds|grills|renders|drives|covers|reports|for\b|when\b|if\b|to\b|:)/i;
const ROUTES = /(?:→|->|=>|⇒)\s*\W{0,4}$/;
const VERB_NEAR =
  /\b(call|calls|calling|invoke|invokes|invoking|run|runs|running|use|uses|using|dispatch|delegate|delegates|spin up|launch|launches|start|trigger|apply|follow|load|loads|execute|switch to|go to|enter|drive|driving|via|with|through)\b(?:\W{1,3}(?:the|a|an))?\W{0,25}$/i;

const RANK: Record<EdgeType, number> = { calls: 3, prerequisite: 2, suggests: 1, reference: 0 };

/** Anything with a markdown body that can name skills: a skill, a plugin command or an agent. */
export type Doc = Pick<ParsedSkill, "id" | "name" | "body" | "bodyStart"> & {
  /** a plugin part: its name resolves only when no skill already has it */
  part?: boolean;
};

export interface DetectResult {
  edges: Edge[];
  flows: Flow[];
  unresolved: UnresolvedMention[];
  mentions: Mention[];
}

export function detect(skills: Doc[], modes: Map<string, Mode>): DetectResult {
  const byName = new Map<string, string>();
  for (const s of skills) {
    if (s.part) continue;
    byName.set(s.id.toLowerCase(), s.id);
    byName.set(s.name.toLowerCase(), s.id);
  }
  for (const s of skills) if (s.part && !byName.has(s.name.toLowerCase())) byName.set(s.name.toLowerCase(), s.id);
  // bare hyphenated names: a skill by its id (as before), a part by its name
  const hyphenated: Array<[string, string]> = [
    ...skills.filter((s) => !s.part && s.id.includes("-")).map((s): [string, string] => [s.id, s.id]),
    ...skills
      .filter(
        (s) =>
          s.part &&
          s.name.includes("-") &&
          new RegExp(`^${NAME}$`).test(s.name) &&
          byName.get(s.name.toLowerCase()) === s.id,
      )
      .map((s): [string, string] => [s.name, s.id]),
  ];

  const mentions: Mention[] = [];
  const flows: Flow[] = [];
  for (const s of skills) {
    const ms = mentionsIn(s, byName, hyphenated);
    mentions.push(...ms);
    flows.push(...flowsIn(s, ms));
  }

  // merge mentions into edges keyed by source|target|type
  const edgeMap = new Map<string, Edge>();
  const unresolvedMap = new Map<string, UnresolvedMention>();
  for (const m of mentions) {
    if (!m.target) {
      if (!["slash", "dollar", "at", "skill-tool", "prose", "skill-uri"].includes(m.pattern)) continue;
      const u = unresolvedMap.get(m.rawName) ?? { name: m.rawName, count: 0, sources: [] };
      u.count++;
      if (!u.sources.includes(m.source)) u.sources.push(m.source);
      unresolvedMap.set(m.rawName, u);
      continue;
    }
    if (m.target === m.source) continue;
    const key = `${m.source}|${m.target}`;
    const line = lineOf(skills, m.source, m.line);
    const ev: Evidence = { line: m.line, snippet: line, pattern: m.pattern, type: m.type };
    const e = edgeMap.get(key);
    if (e) {
      if (!e.evidence.some((x) => x.line === ev.line && x.type === ev.type)) e.evidence.push(ev);
      if (RANK[m.type] > RANK[e.type]) e.type = m.type;
    } else {
      edgeMap.set(key, { source: m.source, target: m.target, type: m.type, evidence: [ev] });
    }
  }
  const ROUTER_MIN = 8;
  const outDegree = new Map<string, Set<string>>();
  for (const e of edgeMap.values()) outDegree.set(e.source, (outDegree.get(e.source) ?? new Set()).add(e.target));
  for (const e of edgeMap.values()) {
    if ((outDegree.get(e.source)?.size ?? 0) >= ROUTER_MIN) {
      for (const ev of e.evidence) if (ev.type === "calls" && ev.pattern !== "skill-tool") ev.type = "suggests";
      e.type = e.evidence.reduce<EdgeType>(
        (t, ev) => (RANK[ev.type ?? "reference"] > RANK[t] ? (ev.type as EdgeType) : t),
        "reference",
      );
    }
    e.evidence.sort((a, b) => RANK[b.type ?? "reference"] - RANK[a.type ?? "reference"] || a.line - b.line);
    e.type = dominantType(e.evidence);
    if (e.type === "calls" && modes.get(e.target) === "manual") e.warning = "manual-target";
  }
  const edges = [...edgeMap.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
  const unresolved = [...unresolvedMap.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { edges, flows, unresolved, mentions };
}

/** The strongest type backed by at least two mentions; otherwise the strongest single mention. */
function dominantType(evidence: Evidence[]): EdgeType {
  const counts = new Map<EdgeType, number>();
  for (const ev of evidence) counts.set(ev.type ?? "reference", (counts.get(ev.type ?? "reference") ?? 0) + 1);
  const order: EdgeType[] = ["calls", "prerequisite", "suggests", "reference"];
  for (const t of order) if ((counts.get(t) ?? 0) >= 2) return t;
  for (const t of order) if (counts.get(t)) return t;
  return "reference";
}

function lineOf(skills: Doc[], id: string, line: number): string {
  const s = skills.find((x) => x.id === id);
  if (!s) return "";
  const text = s.body[line - s.bodyStart] ?? "";
  const t = text.trim();
  return t.length > 220 ? t.slice(0, 217) + "..." : t;
}

function mentionsIn(s: Doc, byName: Map<string, string>, hyphenated: Array<[string, string]>): Mention[] {
  const out: Mention[] = [];
  s.body.forEach((text, i) => {
    const lineNo = s.bodyStart + i;
    const consumed: Array<[number, number]> = [];
    const free = (a: number, b: number) => !consumed.some(([x, y]) => a < y && b > x);

    for (const d of DETECTORS) {
      d.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = d.re.exec(text))) {
        if (d.pattern === "skill-tool") {
          const span = m[0];
          const q = /"([a-z][a-z0-9-]*)"|`([a-z][a-z0-9-]*)`/g;
          let qm: RegExpExecArray | null;
          while ((qm = q.exec(span))) {
            const raw = qm[1] ?? qm[2];
            const start = m.index + qm.index;
            const end = start + qm[0].length;
            if (!free(start, end)) continue;
            consumed.push([start, end]);
            out.push(make(s.id, raw, byName, lineNo, start, end, "skill-tool", "calls"));
          }
          continue;
        }
        const raw = m[d.group];
        if (STOP.has(raw)) continue;
        const start = m.index + m[0].indexOf(raw);
        const end = start + raw.length;
        if (!free(start, end)) continue;
        const target = byName.get(raw.toLowerCase()) ?? null;
        // backticks only count when they name a known skill
        if (d.pattern === "backtick" && !target) continue;
        consumed.push([start, end]);
        const type = target ? classify(text, start, end, d.pattern) : "reference";
        out.push({ source: s.id, target, rawName: raw, line: lineNo, col: start, end, pattern: d.pattern, type });
      }
    }
    // bare hyphenated names (e.g. "grill-with-docs" without a slash) count as references
    for (const [name, id] of hyphenated) {
      if (id === s.id) continue;
      const re = new RegExp(`(?<![\\w/.$@\`-])${escape(name)}(?![\\w/.-])`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const start = m.index;
        const end = start + name.length;
        if (!free(start, end)) continue;
        consumed.push([start, end]);
        out.push({
          source: s.id,
          target: id,
          rawName: name,
          line: lineNo,
          col: start,
          end,
          pattern: "bare",
          type: classify(text, start, end, "bare"),
        });
      }
    }
  });
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

function make(
  source: string,
  raw: string,
  byName: Map<string, string>,
  line: number,
  col: number,
  end: number,
  pattern: string,
  type: EdgeType,
): Mention {
  return { source, target: byName.get(raw.toLowerCase()) ?? null, rawName: raw, line, col, end, pattern, type };
}

/** Guess the relationship from the words around the mention. */
export function classify(text: string, start: number, end: number, pattern: string): EdgeType {
  if (pattern === "skill-tool") return "calls";
  const before = text.slice(Math.max(0, start - 120), start);
  const near = text.slice(Math.max(0, start - 45), start);
  const after = text.slice(end, end + 60);
  if (pattern === "link") return "reference";
  // menu / routing lines: "→ /x", "- **`/x`** sharpens the idea", "/x is for ..."
  if (PREREQ.test(before + " " + after) || PREREQ_AFTER.test(after)) return "prerequisite";
  if (pattern !== "backtick" && pattern !== "bare" && (ROUTES.test(near) || DESCRIBES.test(after))) return "suggests";
  if (/^\s*(?:[-*+]|\d+[.)])\s*\*\*\W{0,3}$/.test(before)) return "suggests";
  // a menu entry with a bold title first: "- **Fix Root Causes** (**principle-fix-root-causes**). Debugging."
  if (/^\s*(?:[-*+]|\d+[.)])\s*\*\*[^*]{1,60}\*\*\s*[(:—–-]?\s*\*{0,2}`?$/.test(before)) return "suggests";
  if (SUGGEST.test(before)) return "suggests";
  if (pattern === "backtick" || pattern === "bare") return VERB_NEAR.test(near) ? "calls" : "reference";
  if (VERB_NEAR.test(near)) return "calls";
  if (/^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*)?\s*$/.test(before)) return "calls"; // imperative at the start of a line or list item
  return "reference";
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* ---------------- flows: sequential / parallel / loop ---------------- */

interface Block {
  start: number;
  end: number;
  text: string;
  /** index within an ordered list, or -1 */
  item: number;
  listId: number;
}

const PARALLEL =
  /\b(in parallel|parallel|concurrent(?:ly)?|simultaneous(?:ly)?|fans? out|fanned out|at once|at the same time)\b/i;
const LOOP =
  /\b(until|loop|repeat(?:ed|s|edly)?|iterate|each round|every round|keep (?:going|asking|running)|one at a time)\b/i;
const UNTIL = /\buntil\s+([^.;:\n]{3,90})/i;

/** Split a body into paragraphs and ordered-list items, tracking file line numbers. */
function blocksOf(s: Doc): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  let listId = 0;
  let inList = false;
  let inFence = false;
  const flush = () => {
    if (cur && cur.text.trim()) blocks.push(cur);
    cur = null;
  };
  s.body.forEach((raw, i) => {
    const lineNo = s.bodyStart + i;
    if (/^\s*```/.test(raw)) inFence = !inFence;
    const blank = raw.trim() === "";
    const heading = /^#{1,6}\s/.test(raw);
    const item = /^\s{0,3}(\d+)[.)]\s+/.exec(raw);
    const bullet = /^\s{0,3}[-*+]\s+/.test(raw);
    if (heading) {
      flush();
      inList = false;
      return;
    }
    if (item && !inFence) {
      if (!inList) {
        listId++;
        inList = true;
      }
      flush();
      cur = { start: lineNo, end: lineNo, text: raw, item: Number(item[1]), listId };
      return;
    }
    if (bullet && !inFence && !inList) {
      flush();
      cur = { start: lineNo, end: lineNo, text: raw, item: -1, listId: 0 };
      return;
    }
    if (blank) {
      // a blank line ends a paragraph but not a list, if the next non-blank line is indented or another item
      const next = s.body.slice(i + 1).find((l) => l.trim() !== "") ?? "";
      const continues = inList && (/^\s{2,}/.test(next) || /^\s{0,3}\d+[.)]\s+/.test(next));
      if (!continues) {
        flush();
        inList = false;
      } else if (cur) {
        cur.text += "\n";
      }
      return;
    }
    if (cur && (inList || !/^\s*[-*+]\s+/.test(raw) || true)) {
      cur.text += "\n" + raw;
      cur.end = lineNo;
      return;
    }
    cur = { start: lineNo, end: lineNo, text: raw, item: -1, listId: 0 };
  });
  flush();
  return blocks;
}

function flowsIn(s: Doc, mentions: Mention[]): Flow[] {
  const flows: Flow[] = [];
  const blocks = blocksOf(s);
  const inBlock = (b: Block) =>
    mentions.filter(
      (m) => m.target && m.target !== s.id && m.line >= b.start && m.line <= b.end && m.type !== "reference",
    );
  const seen = new Set<string>();
  const covered = (steps: string[]) => flows.some((f) => f.kind === "sequential" && isSubsequence(steps, f.steps));
  const add = (kind: FlowKind, steps: string[], label: string, ev: Evidence[], until?: string) => {
    const key = `${kind}|${steps.join(">")}`;
    if (seen.has(key) || steps.length === 0) return;
    if (kind === "sequential" && covered(steps)) return;
    seen.add(key);
    const flow: Flow = { id: `${s.id}:${kind}:${flows.length + 1}`, kind, owner: s.id, steps, label, evidence: ev };
    if (until) flow.until = until.trim().replace(/[,\s]+$/, "");
    flows.push(flow);
  };
  const evidence = (b: Block, ms: Mention[]): Evidence[] => {
    const firstLine = b.text.split("\n")[0].trim();
    const ev: Evidence[] = [
      { line: b.start, snippet: firstLine.length > 220 ? firstLine.slice(0, 217) + "..." : firstLine, pattern: "flow" },
    ];
    for (const m of ms)
      if (!ev.some((e) => e.line === m.line))
        ev.push({ line: m.line, snippet: trimLine(s, m.line), pattern: m.pattern });
    return ev;
  };

  // sequential: an ordered list whose items call skills, in order
  const lists = new Map<number, Block[]>();
  for (const b of blocks) if (b.item > 0) lists.set(b.listId, [...(lists.get(b.listId) ?? []), b]);
  for (const items of lists.values()) {
    const steps: string[] = [];
    const ev: Evidence[] = [];
    for (const b of items) {
      const ms = inBlock(b);
      const targets = [...new Set(ms.map((m) => m.target as string))];
      for (const t of targets) if (steps[steps.length - 1] !== t) steps.push(t);
      ev.push(...evidence(b, ms).filter((e) => ms.length > 0));
    }
    if (new Set(steps).size >= 2) add("sequential", steps, `${s.name}: steps in order`, ev);
  }
  // sequential inside one paragraph: "A ... then B"
  for (const b of blocks) {
    const ms = inBlock(b);
    if (ms.length < 2) continue;
    const distinct = [...new Set(ms.map((m) => m.target as string))];
    if (
      distinct.length >= 2 &&
      /\b(then|after that|next|once .{3,40} (?:done|complete|resolved)|followed by)\b/i.test(b.text)
    ) {
      add("sequential", distinct, `${s.name}: then`, evidence(b, ms));
    }
  }
  // parallel and loop: a block that says so and calls at least one skill
  for (const b of blocks) {
    const ms = inBlock(b);
    if (ms.length === 0) continue;
    // a menu entry ("- **Title** (**skill**). When to use it.") describes the skill, not a flow
    if (/^\s*(?:[-*+]|\d+[.)])\s*\*\*[^*]{1,60}\*\*\s*[(:—–-]?\s*\*{0,2}`?[a-z][a-z0-9-]*`?\*{0,2}\)?\./.test(b.text))
      continue;
    // only mentions within ~160 chars of the cue word belong to the flow
    const lines = b.text.split("\n");
    const offsetOf = (x: Mention) => lines.slice(0, x.line - b.start).reduce((n, l) => n + l.length + 1, 0) + x.col;
    // cue words inside quotes are examples ("/loop until X"), not the skill's own flow
    const cueText = b.text.replace(/"[^"\n]*"|“[^”\n]*”/g, (q) => " ".repeat(q.length));
    const nearCue = (re: RegExp): Mention[] => {
      const m = re.exec(cueText);
      if (!m) return [];
      return ms.filter((x) => Math.abs(offsetOf(x) - m.index) <= 160);
    };
    // "X ... until <condition>": the skill that loops is the nearest one named before the cue
    const subjectOf = (re: RegExp): Mention[] => {
      const m = re.exec(cueText);
      if (!m) return [];
      const before = ms.filter((x) => offsetOf(x) < m.index);
      if (before.length) return [before[before.length - 1]];
      return ms.filter((x) => offsetOf(x) - m.index <= 160).slice(0, 1);
    };
    const par = nearCue(PARALLEL);
    if (par.length)
      add("parallel", [...new Set(par.map((m) => m.target as string))], `${s.name}: in parallel`, evidence(b, par));
    const loop = subjectOf(LOOP);
    if (loop.length) {
      const u = UNTIL.exec(cueText)?.[1];
      add(
        "loop",
        [...new Set(loop.map((m) => m.target as string))],
        u ? `loop until ${u.trim()}` : `${s.name}: loop`,
        evidence(b, loop),
        u,
      );
    }
  }
  return flows;
}

function isSubsequence(small: string[], big: string[]): boolean {
  let i = 0;
  for (const x of big) if (x === small[i]) i++;
  return i === small.length;
}

function trimLine(s: Doc, line: number): string {
  const t = (s.body[line - s.bodyStart] ?? "").trim();
  return t.length > 220 ? t.slice(0, 217) + "..." : t;
}
