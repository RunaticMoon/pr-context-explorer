// Audit schema failures must surface only structural diagnostics. Raw Ajv
// errors carry provider-controlled values and must never be persisted.
import test from "node:test";
import assert from "node:assert/strict";
import {
  sample,
  fixtureRunner,
  unknown,
  observed,
} from "./analysis-v3-fixtures.test.ts";
import {
  collectStatements,
  runPipeline,
  validateAuditOutput,
  type AuditOutput,
} from "../src/server/analysis-v3/index.ts";
import { ValidationError } from "../src/server/analysis-v3/schema.ts";

const CANARY = "CANARY-leak-9f3c7b";

const run = (t: { after: (fn: () => void) => void }) =>
  sample(t).then((s) =>
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "audit-diagnostics-fixture",
      scope: { kind: "pr" },
      runner: fixtureRunner(s, []),
    }).then((result) => ({ s, result })),
  );

test("valid audit output still passes validateAuditOutput", async (t) => {
  const { s, result } = await run(t);
  const clean: AuditOutput = {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    assessedJsonPointers: collectStatements(result.output).map(
      (x) => x.pointer,
    ),
    issues: [],
    unableToVerify: [],
    scopeSummary: unknown("Scripted audit fixture; no semantic evaluation."),
  };
  assert.doesNotThrow(() =>
    validateAuditOutput(clean, result.output, result.validationContext),
  );
});

test("audit schema violation raises output_schema_mismatch with sanitized diagnostics only", async (t) => {
  const { s, result } = await run(t);
  const id = result.validationContext.code[0].evidence.id;
  const malformed = {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    assessedJsonPointers: [],
    [CANARY]: "provider controlled value",
    issues: [
      {
        targetJsonPointer: "/overview/oneLiner",
        category: CANARY,
        severity: "high",
        reason: observed(id),
        evidenceIds: [id],
        action: "downgrade",
      },
    ],
    unableToVerify: [],
    scopeSummary: unknown(),
  };
  let error: unknown;
  try {
    validateAuditOutput(malformed, result.output, result.validationContext);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof ValidationError);
  assert.equal(error.reasonCode, "output_schema_mismatch");
  assert.equal(error.message, "output_schema_mismatch");
  assert.ok(
    Array.isArray(error.schemaErrors) && error.schemaErrors.length > 0,
    "expected sanitized schema diagnostics",
  );
  const serialized = JSON.stringify(error);
  for (const leaked of [
    CANARY,
    "provider controlled value",
    "must NOT",
    "allowed values",
    "params",
    "schemaPath",
  ])
    assert.equal(
      serialized.includes(leaked),
      false,
      `leaked ${leaked} in ${serialized}`,
    );
  assert.ok(
    error.schemaErrors!.some(
      (d) => d.keyword === "additionalProperties" && d.instancePath === "/*",
    ),
    `expected /* additionalProperties in ${serialized}`,
  );
  assert.ok(
    error.schemaErrors!.some(
      (d) => d.keyword === "enum" && d.instancePath === "/issues/*/category",
    ),
    `expected /issues/*/category enum in ${serialized}`,
  );
  for (const d of error.schemaErrors!)
    assert.deepEqual(Object.keys(d).sort(), ["instancePath", "keyword"]);
});

test("oversized audit output still fails as validation_failed without schema diagnostics", async (t) => {
  const { s, result } = await run(t);
  const oversized = {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    assessedJsonPointers: [],
    issues: [],
    unableToVerify: [],
    scopeSummary: unknown("x".repeat(200000)),
  };
  let error: unknown;
  try {
    validateAuditOutput(oversized, result.output, result.validationContext);
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof ValidationError);
  assert.equal(error.reasonCode, "validation_failed");
  assert.equal(error.schemaErrors, undefined);
});
