// adapt: a source's plain find/replace rules (sources.<id>.adapt in skills-sync.json), for skills written for one
// harness that should read right in every other. Pure string work on bytes in memory, the same input giving the same
// output: no model, no network, no file written here. build applies the rules to the text files of a source's skills
// as it copies them into plugins/<id>/; the snapshot under upstream/ and the working set stay as upstream wrote them.
// What a forbid pattern still finds after the rules (on a line no allow pattern accepts) is a check failure; a rule
// that matches nothing in any file of the source is reported, so a stale rule surfaces.

/** One find/replace: `find` a JavaScript regular expression, `replace` its replacement ($1, $& as in String.replace). */
export interface AdaptRule {
  find: string;
  replace: string;
  /** regular expression flags beside the implied g: i, m, s, u */
  flags?: string;
}

/** sources.<id>.adapt: the rules, in order; what must not be left after them; the lines that may keep it. */
export interface Adapt {
  rules?: AdaptRule[];
  /** patterns no adapted file may still match once the rules ran */
  forbid?: string[];
  /** patterns for lines that may keep a forbidden term (a factual mention), tested against each line as a whole */
  allow?: string[];
}

export interface Compiled {
  rules: Array<{ re: RegExp; replace: string }>;
  forbid: Array<{ re: RegExp; pattern: string }>;
  allow: RegExp[];
}

/** One forbidden term left in a file: its line (from 1), the text matched, the forbid pattern that matched it. */
export interface Hit {
  line: number;
  term: string;
  pattern: string;
}

/**
 * The files the rules rewrite and forbid looks at: Markdown and plain text, by extension. Scripts (.sh, .py, .js,
 * .ps1 and the rest), data (.json, .yaml) and files without an extension are copied as upstream wrote them.
 */
const TEXT = /\.(md|mdc|markdown|txt)$/i;

export function isAdapted(rel: string): boolean {
  return TEXT.test(rel);
}

/** The rules and patterns compiled, or every pattern that is not a regular expression, each with its config path. */
export function compileAdapt(
  a: Adapt,
  at = "adapt",
): { ok: true; compiled: Compiled } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const re = (source: string, flags: string, where: string): RegExp | null => {
    try {
      return new RegExp(source, flags);
    } catch (e) {
      errors.push(`${where}: not a regular expression (${e instanceof Error ? e.message : String(e)})`);
      return null;
    }
  };
  const compiled: Compiled = { rules: [], forbid: [], allow: [] };
  (a.rules ?? []).forEach((r, i) => {
    // the schema takes g, i, m, s and u; y (sticky) would stop a rule at its first gap, so it is refused here too
    if (!/^[gimsu]*$/.test(r.flags ?? "")) {
      errors.push(`${at}.rules[${i}].flags: only g, i, m, s and u (${JSON.stringify(r.flags)})`);
      return;
    }
    const flags = [...new Set(`g${r.flags ?? ""}`)].join("");
    const x = re(r.find, flags, `${at}.rules[${i}].find`);
    if (x) compiled.rules.push({ re: x, replace: r.replace });
  });
  (a.forbid ?? []).forEach((p, i) => {
    const x = re(p, "g", `${at}.forbid[${i}]`);
    if (x) compiled.forbid.push({ re: x, pattern: p });
  });
  (a.allow ?? []).forEach((p, i) => {
    const x = re(p, "", `${at}.allow[${i}]`);
    if (x) compiled.allow.push(x);
  });
  return errors.length ? { ok: false, errors } : { ok: true, compiled };
}

/** Every pattern of every source's adapt block that is not a regular expression, as `sources.<id>.adapt...: why`. */
export function adaptProblems(adapts: Record<string, Adapt | undefined>): string[] {
  const out: string[] = [];
  for (const [id, a] of Object.entries(adapts)) {
    if (!a) continue;
    const c = compileAdapt(a, `sources.${id}.adapt`);
    if (!c.ok) out.push(...c.errors);
  }
  return out;
}

/** The file as text when its bytes are UTF-8 (a BOM kept as U+FEFF); null for anything else, which is never adapted. */
function utf8(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** The text after every rule, in order, each rule seeing the one before it; `counts[i]` grows by rule i's matches. */
export function applyRules(text: string, c: Compiled, counts: number[]): string {
  c.rules.forEach((r, i) => {
    const n = [...text.matchAll(r.re)].length;
    counts[i] = (counts[i] ?? 0) + n;
    if (n) text = text.replace(r.re, r.replace);
  });
  return text;
}

/** The files with the rules applied to each adapted one (every other one as it is), and how often each rule matched. */
export function adaptFiles(files: Map<string, Buffer>, c: Compiled): { files: Map<string, Buffer>; counts: number[] } {
  const counts = c.rules.map(() => 0);
  const out = new Map<string, Buffer>();
  for (const [rel, bytes] of files) {
    if (!isAdapted(rel) || !c.rules.length) {
      out.set(rel, bytes);
      continue;
    }
    const before = utf8(bytes);
    if (before === null) {
      // not UTF-8 (a binary file named .md): decoding it would turn its bytes into U+FFFD, so it goes as it is
      out.set(rel, bytes);
      continue;
    }
    const after = applyRules(before, c, counts);
    out.set(rel, after === before ? bytes : Buffer.from(after, "utf8"));
  }
  return { files: out, counts };
}

/**
 * Each forbidden term in the text, once per line and term, on a line no allow pattern matches (anywhere in the line,
 * without its line ending: anchor an allow with ^ and $ to accept only that exact line); lines from 1.
 */
export function forbiddenIn(text: string, c: Compiled): Hit[] {
  const out: Hit[] = [];
  if (!c.forbid.length) return out;
  text.split(/\r?\n/).forEach((line, i) => {
    if (c.allow.some((a) => a.test(line))) return;
    const seen = new Set<string>();
    for (const f of c.forbid)
      for (const m of line.matchAll(f.re)) {
        if (!m[0] || seen.has(`${f.pattern}\0${m[0]}`)) continue;
        seen.add(`${f.pattern}\0${m[0]}`);
        out.push({ line: i + 1, term: m[0], pattern: f.pattern });
      }
  });
  return out;
}

/** Every forbidden term in the adapted files of a set, keyed by relative path, in path order. */
export function forbiddenInFiles(files: Map<string, Buffer>, c: Compiled): Array<Hit & { rel: string }> {
  const out: Array<Hit & { rel: string }> = [];
  if (!c.forbid.length) return out;
  for (const rel of [...files.keys()].filter(isAdapted).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const text = utf8(files.get(rel)!);
    if (text !== null) for (const h of forbiddenIn(text, c)) out.push({ ...h, rel });
  }
  return out;
}

/** Whether a source has anything to adapt or to forbid. */
export function hasAdapt(a: Adapt | undefined): a is Adapt {
  return !!a && !!(a.rules?.length || a.forbid?.length);
}
