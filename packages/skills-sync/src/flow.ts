// flow.yaml: what an own skill does, beside its SKILL.md. The shipped flow.schema.json says its shape; the rules a
// schema cannot say are here: skill is the folder's name, step ids are unique, and after, parallel and join name steps
// that exist. Nothing runs a flow; this only says whether one is well formed.
import YAML from "yaml";
import { shippedSchema, validate } from "./schema.js";

/** What is wrong with a flow.yaml, for a skill in the folder `folder`; each line is `$.path: rule`. Empty when it is valid. */
export function flowProblems(text: string, folder: string): string[] {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (e) {
    return [`not YAML (${firstLine(e)})`];
  }
  const problems = validate(shippedSchema("flow"), doc);
  if (!isObject(doc)) return problems;
  if (typeof doc.skill === "string" && doc.skill !== folder)
    problems.push(`$.skill: ${doc.skill} is not the folder's name, ${folder}`);
  const steps = (Array.isArray(doc.steps) ? doc.steps : []).map((s) => (isObject(s) ? s : {}));
  // the first step to carry an id owns it; a later one with the same id is the duplicate
  const owner = new Map<string, number>();
  steps.forEach((s, i) => {
    if (typeof s.id !== "string") return;
    if (owner.has(s.id)) problems.push(`$.steps[${i}].id: ${s.id} is already the id of steps[${owner.get(s.id)}]`);
    else owner.set(s.id, i);
  });
  // every id another step is named by must be a step of this flow
  steps.forEach((s, i) => {
    for (const key of ["after", "parallel", "join"]) {
      for (const [id, at] of named(s[key]))
        if (!owner.has(id)) problems.push(`$.steps[${i}].${key}${at}: no step has the id ${id}`);
    }
  });
  return problems;
}

/** The step ids a value names: one id, or a list of them, each with its place in the list. */
function named(v: unknown): Array<[id: string, at: string]> {
  if (typeof v === "string") return [[v, ""]];
  if (!Array.isArray(v)) return [];
  return v.flatMap((x, j): Array<[string, string]> => (typeof x === "string" ? [[x, `[${j}]`]] : []));
}

/** The first line of an error's message: a YAML parse error says what and where there, and a code frame follows it. */
export function firstLine(e: unknown): string {
  return String(e instanceof Error ? e.message : e)
    .split("\n")[0]
    .replace(/:$/, "")
    .trim();
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
