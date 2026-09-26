import test from "node:test";
import assert from "node:assert/strict";
import { sample, candidate } from "./analysis-v3-fixtures.test.ts";
import { ValidationError } from "../src/server/analysis-v3/schema.ts";
import {
  mergeContexts,
  planContext,
  validateStage,
  validateV3Output,
} from "../src/server/analysis-v3/index.ts";
const CANARY = "CANARY_0XDEADBEEF_PROP";

test("schema-conforming v3 output still passes validation unchanged", async (t) => {
  const s = await sample(t);
  const p = planContext(s, { kind: "pr" }),
    context = mergeContexts(
      s,
      { kind: "pr" },
      p.chunks.map((c) => c.context),
    );
  const e = context.code.find(
    (c) => c.evidence.commitSha === s.headSha && c.evidence.side === "new",
  )!.evidence;
  assert.doesNotThrow(() => validateV3Output(candidate(s, e), s, context));
});

test("stage schema failure exposes structural diagnostics only", async (t) => {
  const s = await sample(t);
  const p = planContext(s, { kind: "pr" }),
    context = mergeContexts(
      s,
      { kind: "pr" },
      p.chunks.map((c) => c.context),
    );
  const e = context.code.find(
    (c) => c.evidence.commitSha === s.headSha && c.evidence.side === "new",
  )!.evidence;
  const bad: any = candidate(s, e);
  bad[CANARY] = { forged: CANARY };
  bad.analysisStatus = CANARY;
  try {
    validateV3Output(bad, s, context);
    assert.fail("must reject");
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.ok(error instanceof Error);
    assert.equal(error.reasonCode, "output_schema_mismatch");
    assert.equal(error.message, "output_schema_mismatch");
    assert.ok(Array.isArray(error.schemaErrors));
    assert.ok(error.schemaErrors!.length > 0);
    for (const diagnostic of error.schemaErrors!) {
      assert.deepEqual(Object.keys(diagnostic).sort(), [
        "instancePath",
        "keyword",
      ]);
      assert.equal(typeof diagnostic.keyword, "string");
      assert.equal(typeof diagnostic.instancePath, "string");
    }
    const serialized = JSON.stringify({
      message: error.message,
      reasonCode: error.reasonCode,
      schemaErrors: error.schemaErrors,
      stack: error.stack,
    });
    assert.ok(!serialized.includes(CANARY));
    assert.ok(!serialized.includes("must NOT have additional properties"));
    assert.ok(!serialized.includes("allowed values"));
    assert.ok(
      error.schemaErrors!.some(
        (d) => d.keyword === "additionalProperties" && d.instancePath === "/*",
      ),
    );
    assert.ok(
      error.schemaErrors!.some(
        (d) => d.keyword === "enum" && d.instancePath === "/analysisStatus",
      ),
    );
  }
});

test("per-kind schema failure carries that kind's canonical diagnostics", async (t) => {
  const s = await sample(t);
  const p = planContext(s, { kind: "pr" }),
    context = mergeContexts(
      s,
      { kind: "pr" },
      p.chunks.map((c) => c.context),
    );
  const bad: any = {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    analysisStatus: "partial",
    limitations: [],
    missingContext: [],
    taskId: "task-1",
    summary: CANARY,
    findings: [],
    codeExplanations: [],
  };
  bad[CANARY] = CANARY;
  assert.throws(
    () => validateStage(bad, "chunk", s, context),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.reasonCode, "output_schema_mismatch");
      assert.ok(
        Array.isArray(error.schemaErrors) && error.schemaErrors.length > 0,
      );
      assert.ok(!JSON.stringify(error.schemaErrors).includes(CANARY));
      return true;
    },
  );
});
