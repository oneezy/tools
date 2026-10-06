// A small JSON Schema validator: the subset the shipped schemas use, so the tool needs no dependency for it.
// Errors name the path and the rule broken. Not a general validator; extend it when a schema needs a keyword.
import fs from "node:fs";
import path from "node:path";

export type Schema = Record<string, any>;

/** The schema files this package ships, by name (skills-sync for the config, skills-sync.local for this machine's answers, flow for flow.yaml). */
export function shippedSchema(name: string): Schema {
  return JSON.parse(fs.readFileSync(path.join(packageRoot(), "schemas", `${name}.schema.json`), "utf8")) as Schema;
}

/** This package's folder: the nearest one above this file with a package.json (dist/src when built, src under vp test). */
function packageRoot(): string {
  for (let dir = import.meta.dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    if (path.dirname(dir) === dir) return path.resolve(import.meta.dirname, "..", "..");
  }
}

/** Validate `value` against `schema`; the empty list means valid. */
export function validate(schema: Schema, value: unknown, at = "$", root: Schema = schema): string[] {
  const errors: string[] = [];
  if (schema.$ref) {
    const { $ref, ...rest } = schema;
    return validate({ ...resolveRef(root, $ref), ...rest }, value, at, root);
  }
  if (schema.const !== undefined && !same(value, schema.const))
    errors.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e: unknown) => same(e, value)))
    errors.push(`${at}: must be one of ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
  if (schema.type && !hasType(value, schema.type)) {
    errors.push(`${at}: must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
    return errors;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${at}: must be at least ${schema.minLength} characters`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: must match ${schema.pattern}`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum)
    errors.push(`${at}: must be at least ${schema.minimum}`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${at}: must have at least ${schema.minItems} items`);
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length)
      errors.push(`${at}: items must be unique`);
    if (schema.items) value.forEach((v, i) => errors.push(...validate(schema.items, v, `${at}[${i}]`, root)));
  }
  if (isObject(value)) {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${at}: missing ${k}`);
    for (const [k, needs] of Object.entries(schema.dependentRequired ?? {}))
      for (const n of needs as string[]) if (k in value && !(n in value)) errors.push(`${at}: ${k} needs ${n}`);
    for (const [k, v] of Object.entries(value)) {
      const here = `${at}.${k}`;
      const prop = schema.properties?.[k];
      const patterns = Object.entries(schema.patternProperties ?? {}).filter(([re]) => new RegExp(re).test(k));
      if (prop) errors.push(...validate(prop, v, here, root));
      for (const [, sub] of patterns) errors.push(...validate(sub as Schema, v, here, root));
      if (!prop && !patterns.length) {
        if (schema.additionalProperties === false)
          errors.push(
            `${here}: not allowed${schema.patternProperties ? ` (a name must match ${Object.keys(schema.patternProperties).join(" or ")})` : ""}`,
          );
        else if (isObject(schema.additionalProperties))
          errors.push(...validate(schema.additionalProperties, v, here, root));
      }
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s: Schema) => validate(s, value, at, root).length === 0).length;
    if (passing !== 1)
      errors.push(`${at}: must match exactly one of ${schema.oneOf.length} shapes (matches ${passing})`);
  }
  if (schema.anyOf && !schema.anyOf.some((s: Schema) => validate(s, value, at, root).length === 0))
    errors.push(`${at}: matches none of ${schema.anyOf.length} shapes`);
  return errors;
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
  let node: any = root;
  for (const part of ref.slice(2).split("/")) node = node?.[part];
  if (!node) throw new Error(`unresolved $ref ${ref}`);
  return node as Schema;
}

function hasType(value: unknown, type: string | string[]): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => {
    if (t === "array") return Array.isArray(value);
    if (t === "object") return isObject(value);
    if (t === "null") return value === null;
    if (t === "integer") return Number.isInteger(value);
    return typeof value === t;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
