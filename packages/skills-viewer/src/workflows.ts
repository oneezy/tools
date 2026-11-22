import { detect, type Doc } from "./edges.js";
import type { ParsedSkill } from "./parse.js";
import type { WorkflowDocument, WorkflowEvidence, WorkflowReference, WorkflowStep } from "./types.js";
import { dirname, join, relativeTo, type FileSet } from "./vfs.js";

// These are document syntaxes and instruction cues, never directory-name categories.
const TEXT = /\.(md|mdx|markdown|txt)$/i;
const ACTION =
  /^(?:\*\*)?(?:run|call|invoke|use|read|load|open|follow|execute|start|launch|dispatch|spawn|ask|write|create|collect|combine|wait|repeat|choose|select|return|check|review|research|summarize|inspect|compare|gather|send|save|update|apply|acknowledge)\b/i;
const PARALLEL = /\b(?:in parallel|concurrently|simultaneously)\b/i;
const CHOICE = /\b(?:choose|select) (?:exactly )?one\b/i;
const JOIN = /\b(?:wait for all|await all|after all .*?(?:finish|complete)|once all .*?(?:finish|complete))\b/i;

/** Preserve line offsets while excluding fenced code, quotations and HTML comments. */
export function instructionLines(lines: string[]): string[] {
  let fence = "";
  let comment = false;
  let exampleHeading = 0;
  return lines.map((line) => {
    const heading = /^(#{1,6})\s+(.+)/.exec(line);
    if (heading && !fence) {
      if (exampleHeading && heading[1].length <= exampleHeading) exampleHeading = 0;
      if (/\b(?:examples?|sample|demonstration)\b/i.test(heading[2])) exampleHeading = heading[1].length;
    }
    const mark = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (!fence) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = "";
      return "\0";
    }
    if (fence || exampleHeading || /^\s*>/.test(line) || /^\s*(?:for example\b|example:|e\.g\.)/i.test(line))
      return "\0";
    let result = "";
    for (let i = 0; i < line.length;) {
      if (!comment && line.startsWith("<!--", i)) {
        comment = true;
        i += 4;
      } else if (comment && line.startsWith("-->", i)) {
        comment = false;
        i += 3;
      } else {
        if (!comment) result += line[i];
        i++;
      }
    }
    return result;
  });
}

interface Input extends Doc {
  file: string;
  owner: string;
}

/** Inventory all owned files, then analyze explicit references and bounded Markdown structures. */
export function analyzeWorkflows(skills: ParsedSkill[], fs: FileSet): WorkflowDocument[] {
  const documents = new Map<string, WorkflowDocument>();
  const atPath = new Map<string, string>();
  const inputs: Input[] = [];
  const sortedSkills = [...skills].sort((a, b) => b.dir.length - a.dir.length);
  for (const skill of skills) {
    documents.set(skill.id, {
      id: skill.id,
      owner: skill.id,
      file: skill.file,
      label: skill.name,
      kind: "skill",
      references: [],
      sequences: [],
      children: [],
    });
    atPath.set(skill.file, skill.id);
    inputs.push({ ...skill, owner: skill.id, body: instructionLines(skill.body) });
  }
  for (const file of [...fs.paths].sort()) {
    if (atPath.has(file)) continue;
    const owner = sortedSkills.find((s) => relativeTo(s.dir, file) !== null);
    if (!owner) continue;
    const id = `file:${file}`;
    documents.set(id, {
      id,
      owner: owner.id,
      file,
      label: relativeTo(owner.dir, file)!,
      kind: "file",
      references: [],
      sequences: [],
      children: [],
    });
    atPath.set(file, id);
    documents.get(owner.id)!.children.push(id);
    if (TEXT.test(file)) {
      const raw = fs.read(file);
      if (raw !== undefined)
        inputs.push({
          id,
          name: id,
          file,
          owner: owner.id,
          scope: owner.scope,
          resolvable: false,
          body: instructionLines(raw.split(/\r?\n/)),
          bodyStart: 1,
        });
    }
  }
  const evidence = (input: Input, index: number, rule: string): WorkflowEvidence => ({
    file: input.file,
    line: input.bodyStart + index,
    snippet: input.body[index].trim().slice(0, 240),
    rule,
  });
  const mentions = detect(inputs, new Map()).mentions;
  for (const input of inputs) {
    const document = documents.get(input.id)!;
    const owner = skills.find((s) => s.id === input.owner)!;
    const refs: WorkflowReference[] = [];
    for (const mention of mentions.filter((m) => m.source === input.id && m.target && m.pattern !== "link")) {
      // Only explicit invocations and resolved names become skill links. No execution order follows from them.
      const sourceLine = input.body[mention.line - input.bodyStart];
      const negated = /\b(?:do not|don't|never|must not|avoid)\b/i.test(sourceLine);
      refs.push({
        target: mention.target!,
        kind: negated ? "reference" : mention.type,
        evidence: evidence(input, mention.line - input.bodyStart, `skill-${mention.pattern}`),
      });
    }
    input.body.forEach((line, index) => {
      const tokens: string[] = [];
      for (const match of line.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\s*\)|`([^`\n]+)`/g))
        tokens.push(match[1] ?? match[2] ?? match[3]);
      // Unquoted paths must contain a separator or extension. Plain prose words are not paths.
      for (const match of line.matchAll(
        /(?:^|\s)((?:\.?\.?\/)?[\w.-]+(?:\/[\w.-]+)+(?:\/)?|[\w-]+\.[\w]+)(?=$|[\s,;])/g,
      ))
        tokens.push(match[1]);
      for (let token of new Set(tokens)) {
        if (/^(?:[a-z][\w+.-]*:|\/|#)/i.test(token)) continue;
        try {
          token = decodeURIComponent(token.split(/[?#]/)[0]);
        } catch {
          continue;
        }
        if (!token || /^\.{1,2}\/?$/.test(token)) continue;
        // Resolve from the referring document first; then the owning skill. Never guess by basename.
        for (const path of new Set([join(dirname(input.file), token), join(owner.dir, token)])) {
          let target = atPath.get(path);
          let kind: WorkflowReference["kind"] = documents.get(target ?? "")?.kind === "skill" ? "reference" : "file";
          if (!target) {
            const children = [...atPath].filter(([p]) => relativeTo(path, p)).map(([, id]) => id);
            if (!children.length) continue;
            target = `directory:${path}`;
            kind = "directory";
            if (!documents.has(target))
              documents.set(target, {
                id: target,
                owner: owner.id,
                file: path,
                label: relativeTo(owner.dir, path) ?? path,
                kind: "directory",
                references: [],
                sequences: [],
                children,
              });
          }
          refs.push({ target, kind, evidence: evidence(input, index, "resolved-path") });
          break;
        }
      }
    });
    document.references = refs.filter(
      (r, i) =>
        !refs
          .slice(0, i)
          .some((p) => p.target === r.target && p.kind === r.kind && p.evidence.line === r.evidence.line),
    );
    document.sequences = sequences(input, document.references, evidence);
  }
  return [...documents.values()];
}

function sequences(
  input: Input,
  refs: WorkflowReference[],
  evidence: (i: Input, n: number, r: string) => WorkflowEvidence,
): WorkflowStep[][] {
  const output: WorkflowStep[][] = [];
  let run: WorkflowStep[] = [];
  let current: WorkflowStep | undefined;
  let invalid = false;
  let intro: { index: number; kind: "choice" | "parallel" } | undefined;
  let listIntro: typeof intro;
  const flush = () => {
    if (!invalid && run.length) {
      if (listIntro) {
        output.push([
          {
            id: `${input.id}:branches:${input.bodyStart + listIntro.index}`,
            number: "",
            label: input.body[listIntro.index].trim(),
            branchKind: listIntro.kind,
            branches: run,
            evidence: evidence(input, listIntro.index, `explicit-${listIntro.kind}`),
            references: [],
          },
        ]);
      } else output.push(run);
    }
    run = [];
    current = undefined;
    invalid = false;
    listIntro = undefined;
  };
  for (let i = 0; i < input.body.length; i++) {
    const raw = input.body[i];
    const nestedBranch = current?.branchKind && /^\s{2,}\S/.test(raw);
    const numbered = nestedBranch
      ? null
      : (/^ {0,3}\d+[.)]\s+(.+)$/.exec(raw) ?? (intro || listIntro ? /^ {0,3}[-*+]\s+(.+)$/.exec(raw) : null));
    if (numbered) {
      if (!run.length) listIntro = intro;
      intro = undefined;
      const label = numbered[1];
      // A list of nouns, examples or menu entries is not an execution sequence.
      if ((!listIntro && !ACTION.test(label)) || /\b(?:example|for instance)\b/i.test(label)) invalid = true;
      current = {
        id: `${input.id}:step:${input.bodyStart + i}`,
        number: String(run.length + 1),
        label,
        evidence: evidence(input, i, "ordered-action"),
        references: refs.filter((r) => r.evidence.line === input.bodyStart + i),
      };
      if (PARALLEL.test(label)) current.branchKind = "parallel";
      else if (CHOICE.test(label)) current.branchKind = "choice";
      if (/^repeat\b/i.test(label)) current.repeat = label;
      current.join = JOIN.test(label);
      if (current.join) current.joinEvidence = evidence(input, i, "explicit-wait");
      run.push(current);
      continue;
    }
    if (!raw.trim()) continue;
    if (current && /^\s{2,}\S/.test(raw)) {
      const bullet = /^\s{2,}(?:[-*+]|\d+[.)])\s+(.+)$/.exec(raw);
      if (bullet && current.branchKind) {
        const children = (current.branches ??= []);
        children.push({
          id: `${input.id}:task:${input.bodyStart + i}`,
          number: `${current.number}.${children.length + 1}`,
          label: bullet[1],
          evidence: evidence(input, i, `${current.branchKind}-item`),
          references: refs.filter((r) => r.evidence.line === input.bodyStart + i),
        });
      } else {
        current.references.push(...refs.filter((r) => r.evidence.line === input.bodyStart + i));
        if (JOIN.test(raw)) {
          current.join = true;
          current.joinEvidence = evidence(input, i, "explicit-wait");
        }
      }
      continue;
    }
    flush();
    const introduction =
      /:\s*$/.test(raw) && !/^\s*(?:[-*+]|\d+[.)])\s/.test(raw) && !/\b(?:do not|don't|never|must not)\b/i.test(raw);
    intro =
      introduction && CHOICE.test(raw)
        ? { index: i, kind: "choice" }
        : introduction && PARALLEL.test(raw)
          ? { index: i, kind: "parallel" }
          : undefined;
    if (/^repeat\b/i.test(raw))
      output.push([
        {
          id: `${input.id}:repeat:${input.bodyStart + i}`,
          number: "",
          label: raw.trim(),
          repeat: raw.trim(),
          evidence: evidence(input, i, "explicit-repeat"),
          references: refs.filter((r) => r.evidence.line === input.bodyStart + i),
        },
      ]);
  }
  flush();
  // Numbered section headings carry order too. Their body references belong to that section.
  // All peers must be action headings; an ordinary numbered taxonomy stays a reference document.
  const headings = input.body.flatMap((line, i) => {
    const match = /^(#{1,6})\s+(\d+)[.)]\s+(.+)$/.exec(line);
    return match ? [{ i, level: match[1].length, label: match[3], number: match[2] }] : [];
  });
  const levels = new Set(headings.map((h) => h.level));
  for (const level of levels) {
    const peers = headings.filter((h) => h.level === level);
    if (peers.length < 2 || !peers.every((h) => ACTION.test(h.label))) continue;
    // Do not join numbered sections separated by unrelated peer headings or a numbering reset.
    const groups: (typeof peers)[] = [];
    let group: typeof peers = [];
    for (const h of peers) {
      const previous = group.at(-1);
      if (
        previous &&
        (Number(h.number) <= Number(previous.number) ||
          input.body.slice(previous.i + 1, h.i).some((line) => {
            const header = /^(#{1,6})\s+/.exec(line);
            return header && header[1].length <= level;
          }))
      ) {
        groups.push(group);
        group = [];
      }
      group.push(h);
    }
    if (group.length) groups.push(group);
    for (const list of groups.filter((g) => g.length >= 2))
      output.push(
        list.map((h) => {
          let end = input.body.length;
          for (let i = h.i + 1; i < input.body.length; i++) {
            const header = /^(#{1,6})\s+/.exec(input.body[i]);
            if (header && header[1].length <= level) {
              end = i;
              break;
            }
          }
          return {
            id: `${input.id}:section:${input.bodyStart + h.i}`,
            number: h.number,
            label: h.label,
            evidence: evidence(input, h.i, "numbered-action-section"),
            references: refs.filter(
              (r) => r.evidence.line > input.bodyStart + h.i && r.evidence.line < input.bodyStart + end,
            ),
          };
        }),
      );
  }
  return output;
}
