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
 * `minLength`/`maxLength`/`uniqueItems` are additionally restated in the
 * property's `description` so the model still sees the rule.
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

/**
 * Restates constraints that strict providers reject (`minLength`/`maxLength`,
 * `uniqueItems`) in the property's `description`, so the model still sees the
 * rules the canonical schema enforces. Appends to any existing description.
 */
const restateDroppedKeywords = (node: JsonObject): void => {
  const notes: string[] = [];
  const min = node.minLength,
    max = node.maxLength;
  if (typeof min === "number" && typeof max === "number")
    notes.push(`Length ${min}–${max} characters.`);
  else if (typeof min === "number")
    notes.push(`Length at least ${min} characters.`);
  else if (typeof max === "number")
    notes.push(`Length up to ${max} characters.`);
  if (node.uniqueItems === true) notes.push("Items must be unique.");
  if (!notes.length) return;
  node.description =
    typeof node.description === "string" && node.description
      ? `${node.description} ${notes.join(" ")}`
      : notes.join(" ");
};

/** Keywords a conditional `anyOf` branch may use to narrow a property the
 * object already declares. Anything else means the conditional is not the
 * recognized "same properties, tighter values" shape. */
const NARROWING_KEYS = new Set(["const", "type", "minItems", "pattern"]);

/**
 * Recognizes object-level `anyOf` branches that only narrow already-declared
 * properties (the canonical per-kind statement conditions). Returns each
 * branch's property constraints, or undefined when the shape is anything else.
 */
const narrowingBranches = (
  anyOf: unknown,
  baseProps: JsonObject,
): Record<string, JsonObject>[] | undefined => {
  if (!Array.isArray(anyOf) || anyOf.length === 0) return undefined;
  const out: Record<string, JsonObject>[] = [];
  for (const branch of anyOf) {
    if (
      !isRecord(branch) ||
      Object.keys(branch).length !== 1 ||
      !isRecord(branch.properties)
    )
      return undefined;
    const narrowed: Record<string, JsonObject> = {};
    for (const [name, constraint] of Object.entries(branch.properties)) {
      if (
        !Object.hasOwn(baseProps, name) ||
        !isRecord(constraint) ||
        Object.keys(constraint).some((k) => !NARROWING_KEYS.has(k))
      )
        return undefined;
      narrowed[name] = constraint;
    }
    out.push(narrowed);
  }
  return out;
};

/** Applies a recognized narrowing constraint to the base property schema. */
const narrowProp = (base: unknown, constraint: JsonObject): JsonObject => {
  const merged: JsonObject = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(constraint))
    if (key === "const") {
      merged.enum = [value];
      delete merged.const;
    } else merged[key] = value;
  return merged;
};

const SCHEMA_MAP_KEYS = ["properties", "$defs", "definitions"];
const SCHEMA_VALUE_KEYS = ["items", "additionalProperties"];
const SCHEMA_BRANCH_KEYS = ["anyOf", "oneOf"];

function transformNode(node: JsonObject, isRoot = false): void {
  restateDroppedKeywords(node);
  for (const key of Object.keys(node))
    if (UNSUPPORTED_KEYWORDS.has(key)) delete node[key];
  if ("const" in node) {
    node.enum = [node.const];
    delete node.const;
  }
  if (isObjectSchema(node)) {
    if ("anyOf" in node || "oneOf" in node) {
      const props = isRecord(node.properties) ? node.properties : {};
      const narrowed =
        "oneOf" in node ? undefined : narrowingBranches(node.anyOf, props);
      // The strict subset has no conditional application, so recognized
      // narrowing branches become explicit complete object variants (each a
      // full object schema) that keep the conditions visible to the model.
      // Unrecognized conditionals are refused instead of silently dropped:
      // canonical validation would still enforce a rule the provider never
      // sent. The root must stay a plain object schema, so it cannot carry
      // conditional branches either.
      if (isRoot || narrowed === undefined)
        throw new AIError("schema_invalid");
      const variants = narrowed.map((constraints) => {
        const variant = structuredClone(node) as JsonObject;
        delete variant.anyOf;
        const variantProps = variant.properties as JsonObject;
        for (const [name, constraint] of Object.entries(constraints))
          variantProps[name] = narrowProp(variantProps[name], constraint);
        return variant;
      });
      for (const key of Object.keys(node)) delete node[key];
      node.anyOf = variants;
    } else {
      const props = isRecord(node.properties) ? node.properties : {};
      node.properties = props;
      const required = new Set(
        Array.isArray(node.required) ? node.required : [],
      );
      for (const [key, prop] of Object.entries(props))
        if (!required.has(key)) props[key] = nullable(prop);
      node.required = Object.keys(props);
      node.additionalProperties = false;
    }
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
 * (originally optional properties become nullable), unsupported keywords are
 * removed, and object-level conditional `anyOf` branches that only narrow
 * already-declared properties are expanded into complete object variants so
 * the conditions still reach the model. Conditional shapes this transform does
 * not recognize raise `schema_invalid` rather than being dropped, and the same
 * applies to conditional branches on the root. `$defs`/`$ref` structure is
 * preserved. The input schema is not modified and remains the validation
 * contract. The root must be an object schema.
 */
export function toStrictProviderSchema(schema: object): JsonObject {
  if (!isRecord(schema)) throw new AIError("schema_invalid");
  const root = structuredClone(schema) as JsonObject;
  transformNode(root, true);
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

type NullVerdict = "yes" | "no" | "unknown";

const andVerdict = (a: NullVerdict, b: NullVerdict): NullVerdict =>
  a === "no" || b === "no" ? "no" : a === "yes" && b === "yes" ? "yes" : "unknown";

const NO_REFS: ReadonlySet<string> = new Set();

/**
 * Decides whether a canonical property schema accepts the JSON value `null`.
 * "yes"/"no" are proven verdicts; "unknown" covers shapes this restore does
 * not reason about (unresolvable or cyclic `$ref`, non-record schemas,
 * `if`/`then`/`else`) and always resolves to preserving the value.
 */
const nullVerdict = (
  schema: unknown,
  root: unknown,
  seen: ReadonlySet<string>,
): NullVerdict => {
  if (schema === true) return "yes";
  if (schema === false) return "no";
  if (!isRecord(schema)) return "unknown";
  let verdict: NullVerdict = "yes";
  const conjunct = (v: NullVerdict) => {
    verdict = andVerdict(verdict, v);
  };
  if (typeof schema.$ref === "string") {
    const target = seen.has(schema.$ref)
      ? undefined
      : resolvePointer(root, schema.$ref);
    conjunct(
      target === undefined
        ? "unknown"
        : nullVerdict(target, root, new Set([...seen, schema.$ref])),
    );
  }
  if ("const" in schema) conjunct(schema.const === null ? "yes" : "no");
  if (Array.isArray(schema.enum))
    conjunct(schema.enum.includes(null) ? "yes" : "no");
  const type = schema.type;
  if (typeof type === "string") conjunct(type === "null" ? "yes" : "no");
  else if (Array.isArray(type))
    conjunct(type.includes("null") ? "yes" : "no");
  if (isRecord(schema.not)) {
    const inner = nullVerdict(schema.not, root, seen);
    conjunct(inner === "yes" ? "no" : inner === "no" ? "yes" : "unknown");
  } else if ("not" in schema) conjunct("unknown");
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    if (branches.length === 0) {
      conjunct("no");
      continue;
    }
    let branch: NullVerdict = "no";
    for (const b of branches) {
      const v = nullVerdict(b, root, seen);
      if (v === "yes") {
        branch = "yes";
        break;
      }
      if (v === "unknown") branch = "unknown";
    }
    conjunct(branch);
  }
  if (Array.isArray(schema.allOf))
    for (const b of schema.allOf) conjunct(nullVerdict(b, root, seen));
  if ("if" in schema || "then" in schema || "else" in schema)
    conjunct("unknown");
  return verdict;
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
    // Conditional anyOf/oneOf branches on object schemas only narrow values of
    // the same declared properties, so the base object's required/properties
    // decide which keys are optional; the branches are not walked separately.
    const required = new Set(
      Array.isArray(schema.required) ? schema.required : [],
    );
    const props = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (!Object.hasOwn(value, key)) continue;
      if (
        value[key] === null &&
        !required.has(key) &&
        nullVerdict(propSchema, root, NO_REFS) === "no"
      )
        delete value[key];
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
 * keys are deleted again before canonical Ajv validation — but only when the
 * canonical property schema provably rejects `null`. Optional properties whose
 * canonical schema accepts `null` (`type` including "null", `enum`/`const`
 * containing null, an `anyOf`/`oneOf` branch accepting it, or a `$ref`
 * resolving to such a schema) keep the value, and so does any property whose
 * nullability cannot be decided. Returns a new value; the input is not
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
