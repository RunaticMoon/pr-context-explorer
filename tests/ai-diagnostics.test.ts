import test from "node:test";
import assert from "node:assert/strict";
import { Ajv, type ErrorObject } from "ajv";
import { safeSchemaErrors } from "../src/server/ai/diagnostics.ts";
import { AIError } from "../src/server/ai/errors.ts";
import { chunkOutputSchema } from "../src/server/analysis-v3/index.ts";

const ajv = new Ajv({ strict: true, allErrors: true });
const check = ajv.compile(chunkOutputSchema);

const statement = (over: object = {}) => ({
  text: "statement text",
  kind: "observed",
  evidenceIds: ["e1"],
  confidence: "high",
  rationale: "because",
  limitation: "none",
  ...over,
});
const base = () => ({
  schemaVersion: "3",
  snapshotId: "snap",
  analysisStatus: "complete",
  limitations: [],
  missingContext: [],
  taskId: "task",
  summary: statement(),
  findings: [statement()],
  codeExplanations: [],
});
const errorsFor = (value: unknown): ErrorObject[] => {
  assert.equal(check(value), false, "fixture must fail canonical validation");
  return check.errors as ErrorObject[];
};
const fakeError = (
  keyword: string,
  instancePath: string,
  params: Record<string, unknown> = {},
): ErrorObject => ({
  keyword,
  instancePath,
  schemaPath: "#/$defs/secret-marker/schemaPath",
  params,
  message: "raw provider text SECRET-VALUE",
  data: { secret: "SECRET-VALUE" },
});

test("null, undefined and empty error lists produce no diagnostics", () => {
  for (const errors of [null, undefined, []])
    assert.deepEqual(safeSchemaErrors(errors, chunkOutputSchema), []);
});

test("array positions and $defs.statement anyOf paths normalize to canonical names", () => {
  // kind "inferred" requires a non-blank rationale in the canonical anyOf.
  const value = {
    ...base(),
    findings: [statement({ kind: "inferred", rationale: "   " })],
  };
  const diagnostics = safeSchemaErrors(errorsFor(value), chunkOutputSchema);
  assert.ok(
    diagnostics.some(
      (d) => d.keyword === "pattern" && d.instancePath === "/findings/*/rationale",
    ),
    `expected /findings/*/rationale in ${JSON.stringify(diagnostics)}`,
  );
  assert.ok(
    diagnostics.some(
      (d) => d.keyword === "anyOf" && d.instancePath === "/findings/*",
    ),
  );
  assert.ok(
    diagnostics.some(
      (d) => d.keyword === "const" && d.instancePath === "/findings/*/kind",
    ),
  );
});

test("required errors keep canonical property names; additionalProperties never leak the key", () => {
  const missing = { ...base(), summary: statement() };
  delete (missing.summary as Record<string, unknown>).text;
  const diagnostics = safeSchemaErrors(errorsFor(missing), chunkOutputSchema);
  assert.deepEqual(diagnostics, [
    { keyword: "required", instancePath: "/summary/text" },
  ]);
});

test("malicious property names and secret values never appear in diagnostics", () => {
  const evil = JSON.parse(
    '{"__proto__":{"polluted":true},"<script>alert(1)</script>":1,"a/b~c":2}',
  );
  const value = {
    ...base(),
    summary: { ...statement(), ...evil },
    findings: [statement({ kind: "sk-live-secret-token" })],
  };
  const diagnostics = safeSchemaErrors(errorsFor(value), chunkOutputSchema);
  const serialized = JSON.stringify(diagnostics);
  for (const leaked of [
    "__proto__",
    "<script>",
    "a/b~c",
    "sk-live-secret-token",
    "SECRET",
    "polluted",
  ])
    assert.equal(
      serialized.includes(leaked),
      false,
      `leaked ${leaked} in ${serialized}`,
    );
  assert.ok(
    diagnostics.some(
      (d) =>
        d.keyword === "additionalProperties" &&
        d.instancePath === "/summary/*",
    ),
    `expected /summary/* in ${serialized}`,
  );
  assert.ok(
    diagnostics.some(
      (d) => d.keyword === "enum" && d.instancePath === "/findings/*/kind",
    ),
  );
});

test("diagnostics carry only keyword and instancePath keys", () => {
  const diagnostics = safeSchemaErrors(
    [fakeError("type", "/findings/0/text")],
    chunkOutputSchema,
  );
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), [
    "instancePath",
    "keyword",
  ]);
});

test("keywords outside the allowlist map to other", () => {
  const diagnostics = safeSchemaErrors(
    [
      fakeError("if", "/findings/0"),
      fakeError("dependentRequired", "/summary"),
      fakeError("format", "/findings/0"),
      fakeError("minimum", "/findings/0"),
    ],
    chunkOutputSchema,
  );
  assert.deepEqual(
    diagnostics.map((d) => `${d.keyword} ${d.instancePath}`),
    [
      "other /findings/*",
      "other /summary",
      "format /findings/*",
      "minimum /findings/*",
    ],
  );
});

test("duplicate diagnostics are removed", () => {
  const value = {
    ...base(),
    findings: [
      statement({ kind: "inferred", rationale: " " }),
      statement({ kind: "inferred", rationale: " " }),
    ],
  };
  const diagnostics = safeSchemaErrors(errorsFor(value), chunkOutputSchema);
  const keys = diagnostics.map((d) => `${d.keyword} ${d.instancePath}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("at most 8 diagnostics are returned", () => {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const data: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) {
    properties[`p${i}`] = { type: "string" };
    required.push(`p${i}`);
    data[`p${i}`] = i;
  }
  const schema = {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
  const localCheck = new Ajv({ strict: true, allErrors: true }).compile(schema);
  assert.equal(localCheck(data), false);
  const diagnostics = safeSchemaErrors(localCheck.errors, schema);
  assert.equal(diagnostics.length, 8);
  assert.ok(diagnostics.every((d) => d.keyword === "type"));
});

test("instancePath is truncated to 160 characters", () => {
  const long = `prop${"x".repeat(200)}`;
  const schema = {
    type: "object",
    properties: { [long]: { type: "string" } },
    required: [long],
    additionalProperties: false,
  };
  const localCheck = new Ajv({ strict: true, allErrors: true }).compile(schema);
  assert.equal(localCheck({ [long]: 1 }), false);
  const diagnostics = safeSchemaErrors(localCheck.errors, schema);
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.every((d) => d.instancePath.length <= 160));
});

test("AIError without detail keeps existing behavior", () => {
  const error = new AIError("schema_mismatch");
  assert.equal(error.code, "schema_mismatch");
  assert.equal(error.detail, undefined);
  assert.equal(
    error.message,
    "The analysis did not match the supplied JSON Schema.",
  );
  assert.ok(error instanceof Error);
});

test("AIError detail keeps only code, reasonCode and sanitized schemaErrors", () => {
  const error = new AIError("schema_mismatch", {
    code: "schema_mismatch",
    reasonCode: "output_schema_mismatch",
    schemaErrors: [
      {
        keyword: "pattern",
        instancePath: "/findings/*/rationale",
        message: "SECRET-VALUE",
        params: { secret: "SECRET-VALUE" },
      },
    ],
    injected: "SECRET-VALUE",
  } as never);
  assert.deepEqual(error.detail, {
    code: "schema_mismatch",
    reasonCode: "output_schema_mismatch",
    schemaErrors: [
      { keyword: "pattern", instancePath: "/findings/*/rationale" },
    ],
  });
  assert.equal(JSON.stringify(error).includes("SECRET-VALUE"), false);
});

test("AIError detail drops unknown codes and reasonCodes", () => {
  const error = new AIError("schema_mismatch", {
    code: "totally_made_up",
    reasonCode: "evidence_outside_context but with extra text",
  } as never);
  assert.deepEqual(error.detail, { code: "schema_mismatch" });
  const unknownCode = new AIError("provider_failed", {
    code: "validation_failed",
  });
  assert.deepEqual(unknownCode.detail, { code: "validation_failed" });
  const unknown = new AIError("provider_failed", { code: "unknown" });
  assert.deepEqual(unknown.detail, { code: "unknown" });
});

test("AIError accepts an options object carrying detail", () => {
  const error = new AIError("rate_limited", {
    detail: { code: "unknown", reasonCode: "validation_failed" },
  });
  assert.deepEqual(error.detail, {
    code: "unknown",
    reasonCode: "validation_failed",
  });
  const empty = new AIError("rate_limited", { detail: undefined });
  assert.equal(empty.detail, undefined);
});
