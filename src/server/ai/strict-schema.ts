import { AIError } from "./errors.ts";

type JsonObject = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isObjectSchema = (node: JsonObject): boolean =>
  node.type === "object" ||
  (Array.isArray(node.type) && node.type.includes("object")) ||
  isRecord(node.properties);

/**
 * JSON Schema keywords OpenAI strict structured outputs reject or leave
 * unspecified. They are removed from the provider-facing schema only; the
 * canonical schema still enforces every one of them during output validation.
 */
const UNSUPPORTED_KEYWORDS = new Set([
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "uniqueItems",
  "additionalItems",
  "prefixItems",
  "minLength",
  "maxLength",
  "default",
  "examples",
  "$comment",
  "$id",
  "$schema",
  "$anchor",
  "deprecated",
  "readOnly",
  "writeOnly",
  "discriminator",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

/** Wraps a property schema so it also accepts `null`. Strict mode requires
 * every property in `required`, so optionality is expressed via nullability. */
const nullable = (prop: unknown): unknown => {
  if (!isRecord(prop) || typeof prop.$ref === "string" || "const" in prop)
    return { anyOf: [prop, { type: "null" }] };
  if (Array.isArray(prop.anyOf) && !isObjectSchema(prop))
    return { ...prop, anyOf: [...prop.anyOf, { type: "null" }] };
  const out: JsonObject = { ...prop };
  if (Array.isArray(out.enum) && !out.enum.includes(null))
    out.enum = [...out.enum, null];
  if (typeof out.type === "string") {
    if (out.type !== "null") out.type = [out.type, "null"];
  } else if (Array.isArray(out.type)) {
    if (!out.type.includes("null")) out.type = [...out.type, "null"];
  } else if (!Array.isArray(out.enum)) {
    return { anyOf: [prop, { type: "null" }] };
  }
  return out;
};

const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"];
const SCHEMA_VALUE_KEYS = ["items", "additionalProperties"];
const SCHEMA_BRANCH_KEYS = ["anyOf", "oneOf"];

function transformNode(node: JsonObject): void {
  for (const key of Object.keys(node))
    if (UNSUPPORTED_KEYWORDS.has(key)) delete node[key];
  if ("const" in node) {
    node.enum = [node.const];
    delete node.const;
  }
  if (isObjectSchema(node)) {
    // Conditional refinements (branches that only tighten `properties` of the
    // same object) are unsupported structure; canonical Ajv validation keeps
    // enforcing them, so dropping them here does not weaken checking.
    delete node.anyOf;
    delete node.oneOf;
    const props = isRecord(node.properties) ? node.properties : {};
    node.properties = props;
    const required = new Set(
      Array.isArray(node.required) ? node.required : [],
    );
    for (const [key, prop] of Object.entries(props))
      if (!required.has(key)) props[key] = nullable(prop);
    node.required = Object.keys(props);
    node.additionalProperties = false;
  } else if (Array.isArray(node.oneOf)) {
    // `oneOf` is not accepted; as a value-type choice `anyOf` is a strictly
    // weaker superset and canonical validation still enforces exclusivity.
    node.anyOf = [
      ...(Array.isArray(node.anyOf) ? node.anyOf : []),
      ...node.oneOf,
    ];
    delete node.oneOf;
  }
  for (const key of SCHEMA_MAP_KEYS)
    if (isRecord(node[key]))
      for (const value of Object.values(node[key] as JsonObject))
        if (isRecord(value)) transformNode(value);
  for (const key of SCHEMA_VALUE_KEYS)
    if (isRecord(node[key])) transformNode(node[key] as JsonObject);
  for (const key of SCHEMA_BRANCH_KEYS)
    if (Array.isArray(node[key]))
      for (const value of node[key] as unknown[])
        if (isRecord(value)) transformNode(value);
}

/**
 * Converts a canonical JSON Schema into the OpenAI strict structured-output
 * subset that Codex `--output-schema` accepts: objects always carry
 * `additionalProperties: false` and list every property in `required`
 * (originally optional properties become nullable), unsupported keywords and
 * object-level conditional `anyOf`/`oneOf` branches are removed, and
 * `$defs`/`$ref` structure is preserved. The input schema is not modified and
 * remains the validation contract. The root must be an object schema.
 */
export function toStrictProviderSchema(schema: object): JsonObject {
  if (!isRecord(schema)) throw new AIError("schema_invalid");
  const root = structuredClone(schema) as JsonObject;
  transformNode(root);
  if (!isObjectSchema(root)) throw new AIError("schema_invalid");
  return root;
}

const resolvePointer = (root: unknown, ref: string): unknown => {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isRecord(node)) return undefined;
    node = node[segment.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
};

const restore = (value: unknown, schema: unknown, root: unknown): void => {
  if (!isRecord(schema)) return;
  if (typeof schema.$ref === "string") {
    const target = resolvePointer(root, schema.$ref);
    if (isRecord(target) && target !== schema) restore(value, target, root);
    return;
  }
  const objectLevel =
    schema.type === "object" ||
    (Array.isArray(schema.type) && schema.type.includes("object")) ||
    isRecord(schema.properties);
  if (objectLevel) {
    if (!isRecord(value)) return;
    // Conditional anyOf/oneOf branches on object schemas only tighten the same
    // properties, so they are not walked separately.
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    const props = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (!Object.hasOwn(value, key)) continue;
      if (value[key] === null && !required.has(key)) delete value[key];
      else restore(value[key], propSchema, root);
    }
    return;
  }
  for (const key of SCHEMA_BRANCH_KEYS.concat("allOf")) {
    const branches = schema[key];
    if (Array.isArray(branches))
      for (const branch of branches) restore(value, branch, root);
  }
  if (Array.isArray(value)) {
    const items = schema.items;
    if (isRecord(items)) for (const item of value) restore(item, items, root);
    else if (Array.isArray(items))
      value.forEach((item, i) => restore(item, items[i], root));
  }
};

/**
 * Restores provider output produced under a strict provider schema to the
 * canonical shape. Strict mode forces every property into `required`, so a
 * property that is optional in the canonical schema arrives as `null`; those
 * keys are deleted again before canonical Ajv validation. Properties whose
 * canonical schema legitimately accepts `null` (required, or nullable by
 * contract) are left untouched, and the canonical validation result is
 * unchanged for every other value. Returns a new value; the input is not
 * modified.
 */
export function stripProviderNulls(
  value: unknown,
  canonicalSchema: unknown,
): unknown {
  const clone = structuredClone(value);
  restore(clone, canonicalSchema, canonicalSchema);
  return clone;
}
