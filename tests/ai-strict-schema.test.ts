import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import {
  stripProviderNulls,
  toStrictProviderSchema,
} from "../src/server/ai/strict-schema.ts";
import { providerSchemaJson } from "../src/server/ai/cli.ts";
import {
  auditOutputSchema,
  chunkOutputSchema,
  groundedStatementSchema,
  synthesisOutputSchema,
  tourOutputSchema,
  v3OutputSchema,
} from "../src/server/analysis-v3/index.ts";

// Mirrors the offline verifier's strict-mode rule check: every object schema
// needs additionalProperties:false and required covering every property, and
// keywords OpenAI strict mode rejects must be absent. Value-selection `anyOf`
// is allowed; it is intentionally not in this set.
const STRICT_UNSUPPORTED = new Set([
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "patternProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "minContains",
  "maxContains",
  "allOf",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
function strictViolations(
  schema: unknown,
  path: string,
  out: string[],
): string[] {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    schema.forEach((x, i) => strictViolations(x, `${path}[${i}]`, out));
    return out;
  }
  const s = schema as Record<string, unknown>;
  for (const k of Object.keys(s))
    if (STRICT_UNSUPPORTED.has(k)) out.push(`${path}: keyword '${k}'`);
  const isObj =
    s.type === "object" ||
    (Array.isArray(s.type) && s.type.includes("object")) ||
    s.properties;
  if (isObj) {
    if (s.additionalProperties !== false)
      out.push(`${path}: additionalProperties=${JSON.stringify(s.additionalProperties)}`);
    const props = Object.keys((s.properties as object) ?? {});
    const req = new Set((s.required as string[]) ?? []);
    const missing = props.filter((p) => !req.has(p));
    if (missing.length) out.push(`${path}: not required: ${missing.join(",")}`);
  }
  for (const [k, v] of Object.entries(s))
    if (typeof v === "object") strictViolations(v, `${path}/${k}`, out);
  return out;
}
const violations = (schema: unknown) => strictViolations(schema, "#", []);

const canonical = {
  audit: auditOutputSchema,
  chunk: chunkOutputSchema,
  synthesis: synthesisOutputSchema,
  tour: tourOutputSchema,
  v3: v3OutputSchema,
} as const;

for (const [name, schema] of Object.entries(canonical)) {
  test(`${name}: canonical schema violates strict rules, transformed has zero violations`, () => {
    assert.ok(
      violations(schema).length > 0,
      "fixture sanity: canonical schema must exercise the transform",
    );
    const transformed = toStrictProviderSchema(schema);
    assert.equal(transformed.type, "object");
    assert.deepEqual(violations(transformed), []);
  });

  test(`${name}: transformation does not mutate the canonical schema`, () => {
    const before = JSON.stringify(schema);
    toStrictProviderSchema(schema);
    assert.equal(JSON.stringify(schema), before);
  });
}

test("conditional anyOf on an object is stripped; value-selection anyOf is kept", () => {
  const transformed = toStrictProviderSchema(chunkOutputSchema) as Record<
    string,
    any
  >;
  const statement = transformed.$defs.statement;
  assert.equal("anyOf" in statement, false);
  assert.equal("uniqueItems" in statement.properties.evidenceIds, false);
  assert.equal(statement.additionalProperties, false);
  assert.deepEqual(
    [...statement.required].sort(),
    Object.keys(statement.properties).sort(),
  );
  // comparisonFromSha is a value-type choice between a string and null.
  const nullableId =
    transformed.properties.codeExplanations.items.properties.comparisonFromSha;
  assert.equal(nullableId.anyOf.length, 2);
  assert.ok(
    nullableId.anyOf.some(
      (b: Record<string, unknown>) => b.type === "null",
    ),
  );
});

test("optional properties become required-and-nullable, including $ref and enum", () => {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1 },
      note: { type: "string" },
      box: { $ref: "#/$defs/box" },
      kind: { enum: ["a", "b"] },
    },
    required: ["title"],
    additionalProperties: false,
    $defs: {
      box: {
        type: "object",
        properties: { n: { type: "number" }, extra: { type: "string" } },
        required: ["n"],
        additionalProperties: false,
      },
    },
  };
  const t = toStrictProviderSchema(schema) as Record<string, any>;
  assert.deepEqual([...t.required].sort(), ["box", "kind", "note", "title"]);
  assert.deepEqual(t.properties.note.type, ["string", "null"]);
  assert.equal(t.properties.box.anyOf.length, 2);
  assert.equal(t.properties.box.anyOf[0].$ref, "#/$defs/box");
  assert.equal(t.properties.box.anyOf[1].type, "null");
  assert.deepEqual(t.properties.kind.enum, ["a", "b", null]);
  assert.deepEqual(t.$defs.box.properties.extra.type, ["string", "null"]);
  assert.deepEqual([...t.$defs.box.required].sort(), ["extra", "n"]);
});

test("stripProviderNulls removes nulls only where the canonical schema makes the key optional", () => {
  const canonicalSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      note: { type: "string" },
      maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
      box: { $ref: "#/$defs/box" },
    },
    required: ["title", "maybe", "box"],
    additionalProperties: false,
    $defs: {
      box: {
        type: "object",
        properties: { n: { type: "number" }, extra: { type: "string" } },
        required: ["n"],
        additionalProperties: false,
      },
    },
  };
  const ajv = new Ajv({ strict: true });
  const check = ajv.compile(canonicalSchema);
  // Provider-style output: every declared key present, optionals as null.
  const providerOutput = {
    title: "t",
    note: null,
    maybe: null,
    box: { n: 1, extra: null },
  };
  assert.equal(check(providerOutput), false, "canonical rejects nulled optionals");
  const restored = stripProviderNulls(providerOutput, canonicalSchema);
  assert.deepEqual(restored, { title: "t", maybe: null, box: { n: 1 } });
  assert.equal(check(restored), true);
  // `maybe` is canonical-required and legitimately null: it is kept.
  assert.equal(
    (restored as Record<string, unknown>).maybe === null &&
      Object.hasOwn(restored as object, "maybe"),
    true,
  );
  // Input is not mutated.
  assert.equal(providerOutput.note, null);
  // Required property arriving null is preserved so canonical still rejects it.
  const bad = stripProviderNulls(
    { title: null, maybe: "x", box: { n: 1 } },
    canonicalSchema,
  );
  assert.equal(check(bad), false);
  assert.equal((bad as Record<string, unknown>).title, null);
});

test("canonical validation still rejects output the stripped conditions forbade", () => {
  const check = new Ajv({ strict: true, allErrors: true }).compile(
    chunkOutputSchema,
  );
  const statement = (over: object = {}) => ({
    text: "statement text",
    kind: "observed",
    evidenceIds: ["e1"],
    confidence: "high",
    rationale: "because",
    limitation: "none",
    ...over,
  });
  const base = {
    schemaVersion: "3",
    snapshotId: "snap",
    analysisStatus: "complete",
    limitations: [],
    missingContext: [],
    taskId: "task",
    summary: statement(),
    findings: [statement()],
    codeExplanations: [],
  };
  assert.equal(check(base), true);
  // kind "observed" requires non-empty evidenceIds under the canonical anyOf.
  const violating = {
    ...base,
    findings: [statement({ evidenceIds: [] })],
  };
  assert.equal(check(violating), false);
  // The provider-facing schema no longer encodes that condition (it accepts the
  // value), which proves the constraint survives only in canonical validation.
  const providerCheck = new Ajv({ strict: true }).compile(
    toStrictProviderSchema(chunkOutputSchema),
  );
  assert.equal(providerCheck(violating), true);
});

test("providerSchemaJson transforms only the Codex schema file content", () => {
  const canonicalJson = JSON.stringify(chunkOutputSchema);
  const claudeText = providerSchemaJson("claude", chunkOutputSchema);
  assert.equal(claudeText, canonicalJson);
  const codexSchema = JSON.parse(
    providerSchemaJson("codex", chunkOutputSchema),
  );
  assert.deepEqual(violations(codexSchema), []);
});

test("groundedStatementSchema alone is not a valid strict root but transforms inside $defs", () => {
  assert.equal(violations(groundedStatementSchema).length > 0, true);
});
