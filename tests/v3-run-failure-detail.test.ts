import test from "node:test";
import assert from "node:assert/strict";
import { sample, fixtureRunner } from "./analysis-v3-fixtures.test.ts";
import { AIError } from "../src/server/ai/errors.ts";
// Deterministic runner fixtures test orchestration ONLY. No CLI/model inference occurs.
const api = () => import("../src/server/analysis-v3/index.ts");

const CANARY = "CANARY_raw_provider_stderr_9f8e7d6c";

test("chunk schema violation records validation_failed with reasonCode, schemaErrors and coverage reason aggregation", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    events: any[] = [],
    base = fixtureRunner(s, []);
  let first = true;
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "chosen",
    scope: { kind: "pr" },
    onEvent: (e: any) => events.push(e),
    runner: async (r: any) => {
      const out = await base(r);
      if (r.stage === "chunk" && first) {
        first = false;
        return {
          output: { ...out.output, findings: [{}] },
          metadata: out.metadata,
        };
      }
      return out;
    },
  });
  assert.equal(result.processStatus, "succeeded");
  const failed = result.metadata.stages.filter(
    (x) => x.stage === "chunk" && x.status === "failed",
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorCode, "validation_failed");
  assert.equal(failed[0].reasonCode, "output_schema_mismatch");
  assert.ok(
    Array.isArray(failed[0].schemaErrors) && failed[0].schemaErrors.length,
  );
  assert.ok(
    failed[0].schemaErrors!.every(
      (d) =>
        typeof d.keyword === "string" && typeof d.instancePath === "string",
    ),
  );
  assert.deepEqual(result.coverage.chunkFailureCodes, {
    validation_failed: 1,
  });
  assert.deepEqual(result.coverage.chunkFailureReasons, {
    output_schema_mismatch: 1,
  });
  const event = events.find((e) => e.type === "failed" && e.stage === "chunk");
  assert.equal(event?.event?.code, "validation_failed");
  assert.equal(event?.event?.reasonCode, "output_schema_mismatch");
});

test("AIError detail is preserved on stage records and chunk failure aggregation", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api();
  const detail = {
    code: "schema_mismatch" as const,
    reasonCode: "output_schema_mismatch" as const,
    schemaErrors: [
      { keyword: "required", instancePath: "/findings/*/evidenceIds" },
    ],
  };
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner: async () => {
        throw new AIError("schema_mismatch", detail);
      },
    }),
    (e: any) => {
      assert.equal(e.code, "all_chunks_failed");
      assert.deepEqual(e.chunkFailureCodes, {
        schema_mismatch: e.coverage.plannedChunks,
      });
      assert.deepEqual(e.coverage.chunkFailureCodes, e.chunkFailureCodes);
      assert.deepEqual(e.coverage.chunkFailureReasons, {
        output_schema_mismatch: e.coverage.plannedChunks,
      });
      const failed = e.stages.filter(
        (x: any) => x.stage === "chunk" && x.status === "failed",
      );
      assert.equal(failed.length, e.coverage.plannedChunks);
      for (const stage of failed) {
        assert.equal(stage.errorCode, "schema_mismatch");
        assert.equal(stage.reasonCode, "output_schema_mismatch");
        assert.deepEqual(stage.schemaErrors, detail.schemaErrors);
      }
      return true;
    },
  );
});

test("synthesis failure still exposes chunk failure codes and reasons in coverage", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    base = fixtureRunner(s, []);
  let first = true;
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner: async (r: any) => {
        const out = await base(r);
        if (r.stage === "chunk" && first) {
          first = false;
          return {
            output: { ...out.output, findings: [{}] },
            metadata: out.metadata,
          };
        }
        if (r.stage === "synthesis") throw new AIError("provider_unavailable");
        return out;
      },
    }),
    (e: any) => {
      assert.equal(e.code, "synthesis_failed");
      assert.equal(e.processStatus, "failed");
      assert.deepEqual(e.coverage.chunkFailureCodes, {
        validation_failed: 1,
      });
      assert.deepEqual(e.coverage.chunkFailureReasons, {
        output_schema_mismatch: 1,
      });
      const synthesis = e.stages.find((x: any) => x.stage === "synthesis");
      assert.equal(synthesis?.status, "failed");
      assert.equal(synthesis?.errorCode, "provider_unavailable");
      return true;
    },
  );
});

test("serialized stages, coverage and events never retain raw error text or offending values", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    events: any[] = [],
    base = fixtureRunner(s, []);
  const assertNoLeak = (e: any) => {
    assert.equal(e.code, "all_chunks_failed");
    const serialized = JSON.stringify({
      stages: e.stages,
      coverage: e.coverage,
      chunkFailureCodes: e.chunkFailureCodes,
      events,
    });
    assert.ok(!serialized.includes(CANARY));
    assert.ok(!serialized.includes("leaked"));
    return true;
  };
  // Schema-violating output embedding untrusted text normalizes away.
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      onEvent: (e: any) => events.push(e),
      runner: async (r: any) => {
        const out = await base(r);
        if (r.stage === "chunk")
          return {
            output: {
              ...out.output,
              summary: { ...out.output.summary, leaked: CANARY },
            },
            metadata: out.metadata,
          };
        return out;
      },
    }),
    assertNoLeak,
  );
  // A raw provider error message is never retained anywhere.
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      onEvent: (e: any) => events.push(e),
      runner: async () => {
        throw Error(CANARY);
      },
    }),
    assertNoLeak,
  );
});

test("provider call budget and engine identity reach the runner unchanged; exhaustion defers remaining chunks", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    calls: any[] = [],
    base = fixtureRunner(s, []);
  const budget = {
    used: 0,
    limit: 1,
    reserve(_maxOutputTokens: number) {
      budget.used += 1;
    },
  };
  const engine = {
    transport: "http" as const,
    providerId: "openai-compatible" as const,
    model: "chosen",
    host: "127.0.0.1:18080",
    configId: "cfg-test",
    revision: 3,
  };
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "openai-compatible",
      model: "chosen",
      scope: { kind: "pr" },
      budget,
      engine,
      runner: async (r: any) => {
        calls.push(r);
        r.budget?.reserve(8192);
        return base(r);
      },
    }),
    (e: any) => {
      assert.equal(e.code, "synthesis_failed");
      assert.equal(e.coverage.analyzedChunks, 1);
      assert.equal(e.coverage.failedChunks, 0);
      assert.ok(e.coverage.notStartedChunks >= 1);
      assert.ok(
        e.coverage.omitted.some(
          (x: any) => x.reason === "not_started_call_budget",
        ),
      );
      assert.equal(
        e.stages.filter(
          (x: any) => x.stage === "chunk" && x.status === "validated",
        ).length,
        1,
      );
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls.every((c) => c.budget === budget && c.engine === engine));
});
