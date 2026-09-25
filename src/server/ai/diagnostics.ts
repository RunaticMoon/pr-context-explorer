import type { ErrorObject } from "ajv";
import type { SchemaDiagnostic } from "../../ai-contract.ts";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only these Ajv keywords may be reported; everything else is "other". */
const ALLOWED_KEYWORDS = new Set([
  "type",
  "required",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "oneOf",
  "format",
  "minimum",
  "maximum",
]);

const MAX_DIAGNOSTICS = 8;
const MAX_PATH_LENGTH = 160;
const BRANCH_KEYS = ["anyOf", "oneOf"];

const resolvePointer = (root: unknown, ref: string): unknown => {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(node)) return undefined;
    node = node[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
};

/**
 * Expands a set of schema nodes for one position: local `$ref` targets are
 * resolved and `anyOf`/`oneOf` branches are unioned in, so a path segment is
 * matched against every schema that could apply there.
 */
const expand = (nodes: JsonObject[], root: JsonObject): JsonObject[] => {
  const out: JsonObject[] = [];
  const seen = new Set<JsonObject>();
  const stack = [...nodes];
  while (stack.length) {
    let node = stack.pop() as JsonObject;
    const resolved = new Set<JsonObject>();
    while (typeof node.$ref === "string" && !resolved.has(node)) {
      resolved.add(node);
      const target = resolvePointer(root, node.$ref);
      if (!isRecord(target)) break;
      node = target;
    }
    if (seen.has(node)) continue;
    seen.add(node);
    out.push(node);
    for (const key of BRANCH_KEYS) {
      const branches = node[key];
      if (Array.isArray(branches))
        for (const branch of branches) if (isRecord(branch)) stack.push(branch);
    }
  }
  return out;
};

const isObjectSchema = (node: JsonObject): boolean =>
  node.type === "object" ||
  (Array.isArray(node.type) && node.type.includes("object")) ||
  isRecord(node.properties);

/**
 * Walks one instance-path segment against the candidate schemas. The raw
 * segment survives only when the canonical schema literally defines it as a
 * property; array positions and unknown names become "*". Returns the
 * normalized segment and the schemas for the next position.
 */
const descend = (
  nodes: JsonObject[],
  segment: string,
  root: JsonObject,
): { name: string; next: JsonObject[] } => {
  let literal = false;
  const next: JsonObject[] = [];
  const nextSeen = new Set<JsonObject>();
  const push = (value: unknown) => {
    if (isRecord(value) && !nextSeen.has(value)) {
      nextSeen.add(value);
      next.push(value);
    }
  };
  for (const node of expand(nodes, root)) {
    const properties = isRecord(node.properties)
      ? node.properties
      : undefined;
    if (properties && Object.hasOwn(properties, segment)) {
      literal = true;
      push(properties[segment]);
    } else if (properties !== undefined || isObjectSchema(node)) {
      push(node.additionalProperties);
    }
    const items = node.items;
    if (Array.isArray(items)) {
      const index = /^\d{1,9}$/.test(segment) ? Number(segment) : -1;
      push(index >= 0 ? items[index] : undefined);
    } else {
      push(items);
    }
  }
  return { name: literal ? segment : "*", next };
};

const unescape = (segment: string): string =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");

/**
 * Normalizes an Ajv instancePath by walking the canonical schema. `required`
 * and `additionalProperties` errors point at the parent object; the offending
 * property name from `params` is appended only when the canonical schema
 * defines it, otherwise "*" — the raw name is never emitted.
 */
const normalizePath = (error: ErrorObject, root: JsonObject): string => {
  const raw = typeof error.instancePath === "string" ? error.instancePath : "";
  const parts = raw.split("/");
  const segments = parts[0] === "" ? parts.slice(1) : parts;
  const out: string[] = [];
  let nodes: JsonObject[] = [root];
  for (const part of segments) {
    const step = descend(nodes, unescape(part), root);
    out.push(step.name);
    nodes = step.next;
  }
  if (
    error.keyword === "required" ||
    error.keyword === "additionalProperties"
  ) {
    const params = isRecord(error.params) ? error.params : {};
    const prop =
      error.keyword === "required"
        ? params.missingProperty
        : params.additionalProperty;
    let known = false;
    if (typeof prop === "string")
      for (const node of expand(nodes, root)) {
        if (isRecord(node.properties) && Object.hasOwn(node.properties, prop)) {
          known = true;
          break;
        }
      }
    out.push(known ? (prop as string) : "*");
  }
  return out.length ? `/${out.join("/")}` : "";
};

/**
 * Converts raw Ajv errors into value-free structural diagnostics. Ajv
 * `message`, `params`, `data` and `schemaPath` are never copied; keywords are
 * allowlist-mapped and paths keep only canonical property names with array
 * positions as "*". At most 8 unique diagnostics, paths capped at 160 chars.
 */
export function safeSchemaErrors(
  errors: ErrorObject[] | null | undefined,
  canonicalSchema: object,
): SchemaDiagnostic[] {
  const root = isRecord(canonicalSchema) ? canonicalSchema : {};
  const out: SchemaDiagnostic[] = [];
  const seen = new Set<string>();
  for (const error of errors ?? []) {
    if (!isRecord(error)) continue;
    const keyword =
      typeof error.keyword === "string" && ALLOWED_KEYWORDS.has(error.keyword)
        ? error.keyword
        : "other";
    const instancePath = normalizePath(error, root).slice(0, MAX_PATH_LENGTH);
    const key = `${keyword}\n${instancePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ keyword, instancePath });
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}
