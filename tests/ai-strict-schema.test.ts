import test from "node:test";
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import { AIError } from "../src/server/ai/errors.ts";
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

test("conditional anyOf on an object expands into complete variants; value-selection anyOf is kept", () => {
  const transformed = toStrictProviderSchema(chunkOutputSchema) as Record<
    string,
    any
  >;
  const statement = transformed.$defs.statement;
  assert.equal(statement.anyOf.length, 3);
  const allKeys = [
    "text",
    "kind",
    "evidenceIds",
    "confidence",
    "rationale",
    "limitation",
  ];
  for (const variant of statement.anyOf) {
    assert.equal(variant.type, "object");
    assert.equal(variant.additionalProperties, false);
    assert.deepEqual(
      [...variant.required].sort(),
      allKeys.slice().sort(),
    );
    assert.deepEqual(
      Object.keys(variant.properties).sort(),
      allKeys.slice().sort(),
    );
  }
  const [observed, inferred, unknown] = statement.anyOf;
  assert.deepEqual(observed.properties.kind.enum, ["observed"]);
  assert.equal(observed.properties.evidenceIds.minItems, 1);
  assert.equal(observed.properties.evidenceIds.maxItems, 100);
  assert.equal("uniqueItems" in observed.properties.evidenceIds, false);
  assert.deepEqual(inferred.properties.kind.enum, ["inferred"]);
  assert.equal(inferred.properties.evidenceIds.minItems, 1);
  assert.equal(inferred.properties.rationale.pattern, "\\S");
  assert.deepEqual(unknown.properties.kind.enum, ["unknown"]);
  assert.equal(unknown.properties.limitation.pattern, "\\S");
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

test("canonical validation still rejects output the kind conditions forbade", () => {
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
  // The provider-facing schema now encodes the same condition through the
  // expanded anyOf variants, so it rejects the value before canonical runs.
  const providerCheck = new Ajv({ strict: true }).compile(
    toStrictProviderSchema(chunkOutputSchema),
  );
  assert.equal(providerCheck(violating), false);
  assert.equal(providerCheck(base), true);
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

const statement = (over: object = {}) => ({
  text: "statement text",
  kind: "observed",
  evidenceIds: ["e1"],
  confidence: "high",
  rationale: "because",
  limitation: "none",
  ...over,
});

test("provider statement variants enforce the canonical kind conditions", () => {
  const transformed = toStrictProviderSchema(chunkOutputSchema) as Record<
    string,
    any
  >;
  const check = new Ajv({ strict: true, allErrors: true }).compile(
    transformed.$defs.statement,
  );
  assert.equal(check(statement()), true);
  assert.equal(check(statement({ kind: "inferred" })), true);
  assert.equal(
    check(statement({ kind: "unknown", evidenceIds: [] })),
    true,
  );
  // The conditions Codex previously never saw are now rejected at the
  // provider schema, before canonical validation.
  assert.equal(
    check(statement({ kind: "inferred", evidenceIds: [] })),
    false,
  );
  assert.equal(
    check(statement({ kind: "inferred", rationale: "  " })),
    false,
  );
  assert.equal(check(statement({ evidenceIds: [] })), false);
  assert.equal(
    check(statement({ kind: "unknown", limitation: "" })),
    false,
  );
});

test("dropped length and uniqueness constraints are restated in descriptions", () => {
  const t = toStrictProviderSchema(chunkOutputSchema) as Record<string, any>;
  const observed = t.$defs.statement.anyOf[0];
  const text = observed.properties.text;
  assert.equal(text.minLength, undefined);
  assert.equal(text.maxLength, undefined);
  assert.match(text.description, /Length 1–6000 characters\./);
  const evidenceIds = observed.properties.evidenceIds;
  assert.equal(evidenceIds.uniqueItems, undefined);
  assert.match(evidenceIds.description, /Items must be unique\./);
  assert.match(evidenceIds.items.description, /Length 1–512 characters\./);
  assert.match(
    observed.properties.rationale.description,
    /Length up to 6000 characters\./,
  );
  // An existing description keeps its text and gains the restated rule.
  const t2 = toStrictProviderSchema({
    type: "object",
    properties: {
      name: { type: "string", maxLength: 10, description: "Display name." },
    },
    required: ["name"],
    additionalProperties: false,
  }) as Record<string, any>;
  assert.equal(
    t2.properties.name.description,
    "Display name. Length up to 10 characters.",
  );
});

test("unrecognized conditional shapes fail with schema_invalid instead of silent dropping", () => {
  const schemaInvalid = (e: unknown) =>
    e instanceof AIError && e.code === "schema_invalid";
  // Conditional anyOf on the root is refused: the root must stay an object.
  assert.throws(
    () => toStrictProviderSchema(groundedStatementSchema),
    schemaInvalid,
  );
  const root = (defsStatement: unknown) => ({
    type: "object",
    properties: { taskId: { type: "string" } },
    required: ["taskId"],
    additionalProperties: false,
    $defs: { statement: defsStatement },
  });
  const baseProps = {
    kind: { enum: ["observed", "inferred", "unknown"] },
    evidenceIds: { type: "array" },
  };
  // Branch narrowing a property the base does not declare.
  assert.throws(
    () =>
      toStrictProviderSchema(
        root({
          type: "object",
          properties: baseProps,
          required: ["kind", "evidenceIds"],
          additionalProperties: false,
          anyOf: [{ properties: { other: { const: "x" } } }],
        }),
      ),
    schemaInvalid,
  );
  // Branch constraint keyword outside the recognized narrowing set.
  assert.throws(
    () =>
      toStrictProviderSchema(
        root({
          type: "object",
          properties: baseProps,
          required: ["kind", "evidenceIds"],
          additionalProperties: false,
          anyOf: [{ properties: { evidenceIds: { minLength: 1 } } }],
        }),
      ),
    schemaInvalid,
  );
  // Branch carrying anything beyond `properties`.
  assert.throws(
    () =>
      toStrictProviderSchema(
        root({
          type: "object",
          properties: baseProps,
          required: ["kind", "evidenceIds"],
          additionalProperties: false,
          anyOf: [
            {
              properties: { kind: { const: "observed" } },
              required: ["evidenceIds"],
            },
          ],
        }),
      ),
    schemaInvalid,
  );
  // Object-level oneOf is not silently dropped either.
  assert.throws(
    () =>
      toStrictProviderSchema(
        root({
          type: "object",
          properties: baseProps,
          required: ["kind", "evidenceIds"],
          additionalProperties: false,
          oneOf: [{ properties: { kind: { const: "observed" } } }],
        }),
      ),
    schemaInvalid,
  );
});

test("stripProviderNulls preserves optional nulls the canonical schema accepts and unclear verdicts", () => {
  const canonicalSchema = {
    type: "object",
    properties: {
      optPlain: { type: "string" },
      optNullable: { anyOf: [{ type: "string" }, { type: "null" }] },
      optEnum: { enum: ["a", null] },
      optRefNullable: { $ref: "#/$defs/maybeText" },
      optDangling: { $ref: "#/$defs/missing" },
      optOpen: true,
    },
    required: [],
    additionalProperties: false,
    $defs: {
      maybeText: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
  const out = stripProviderNulls(
    {
      optPlain: null,
      optNullable: null,
      optEnum: null,
      optRefNullable: null,
      optDangling: null,
      optOpen: null,
    },
    canonicalSchema,
  );
  assert.deepEqual(out, {
    optNullable: null,
    optEnum: null,
    optRefNullable: null,
    optDangling: null,
    optOpen: null,
  });
});
