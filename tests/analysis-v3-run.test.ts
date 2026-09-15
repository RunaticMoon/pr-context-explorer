import test from "node:test";
import assert from "node:assert/strict";
import {
  sample,
  candidate,
  unknown,
  observed,
  step,
  fixtureRunner,
} from "./analysis-v3-fixtures.test.ts";
import type { LiveSnapshot } from "../src/server/analysis-v3/index.ts";
// Deterministic runner fixtures test orchestration ONLY. No CLI/model inference occurs.
const api = () => import("../src/server/analysis-v3/index.ts");

test("actual bounded stages validate/cache chunk outputs, synthesize grounded PR then separately create head tour", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    calls: any[] = [],
    events: any[] = [];
  const store = new Map<string, any>(),
    cache = {
      get: (k: string) => store.get(k),
      set: (k: string, v: any) => {
        store.set(k, v);
      },
    };
  const args = {
    snapshot: s,
    providerId: "codex" as const,
    model: "explicit-model",
    scope: { kind: "pr" } as const,
    runner: fixtureRunner(s, calls),
    cache,
    onEvent: (e: any) => events.push(e),
  };
  const result = await runPipeline(args);
  assert.equal(result.processStatus, "succeeded");
  assert.equal(result.output.analysisStatus, "complete");
  assert.ok(calls.filter((c) => c.stage === "chunk").length > 1);
  assert.equal(calls.filter((c) => c.stage === "synthesis").length, 1);
  assert.equal(calls.filter((c) => c.stage === "tour").length, 1);
  assert.ok(
    calls.every(
      (c) =>
        c.providerId === "codex" &&
        c.model === "explicit-model" &&
        c.schema &&
        c.trustedPrompt.includes("untrusted"),
    ),
  );
  assert.ok(
    calls.every(
      (c) =>
        Buffer.byteLength(JSON.stringify(c.context)) <=
        (c.stage === "chunk" ? 40000 : 180000),
    ),
  );
  assert.equal(result.output.tour.tourRevisionSha, s.headSha);
  assert.equal(result.semanticAudit.status, "not_performed");
  assert.equal(result.deterministicValidation.status, "passed");
  assert.equal(result.coverage.targetTestsExecuted, false);
  assert.equal(result.coverage.externalCIQueried, false);
  assert.equal(result.coverage.analyzedChunks, result.coverage.plannedChunks);
  assert.deepEqual(
    result.commitOrder,
    s.phases.map((p) => p.sha),
  );
  const count = calls.length,
    again = await runPipeline(args);
  assert.equal(calls.length, count);
  assert.ok(again.metadata.stages.every((x) => x.cacheHit));
  assert.equal(again.output.tour.tourId, result.output.tour.tourId);
  assert.ok(events.some((e) => e.type === "cache_hit"));
  await runPipeline({ ...args, model: "different-model" });
  assert.ok(calls.length > count);
});

test("chunk failure is retained through synthesis as partial, never cached or silently replaced by another engine", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    calls: any[] = [];
  let first = true;
  const runner = fixtureRunner(s, calls, (r) => {
    if (r.stage === "chunk" && first) {
      first = false;
      throw Error("simulated runner failure; NOT real inference");
    }
  });
  const result = await runPipeline({
    snapshot: s,
    providerId: "claude",
    model: "chosen",
    scope: { kind: "pr" },
    runner,
  });
  assert.equal(result.processStatus, "succeeded");
  assert.equal(result.output.analysisStatus, "partial");
  assert.equal(result.coverage.failedChunks, 1);
  assert.ok(result.coverage.omitted.some((x) => x.reason === "chunk_failed"));
  assert.ok(result.output.missingContext.length);
  assert.ok(calls.every((c) => c.providerId === "claude"));
});

test("cancellation and finite deadlines stop calls even when injected runner ignores signal", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api();
  const abort = new AbortController();
  abort.abort();
  let calls = 0;
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      signal: abort.signal,
      runner: async () => {
        calls++;
        return new Promise(() => {});
      },
    }),
    /cancelled/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      budgets: { callTimeoutMs: 5, totalTimeoutMs: 25 },
      runner: async () => {
        calls++;
        return new Promise(() => {});
      },
    }),
    /timeout|failed/,
  );
  assert.ok(calls > 0);
});

export { fixtureRunner };

test("unstarted tasks on call budget exhaustion are retained in failure coverage", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api();
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      budgets: { maxCalls: 1 },
      runner: fixtureRunner(s, []),
    }),
    (e: any) => {
      assert.equal(e.processStatus, "failed");
      assert.ok(
        e.coverage.omitted.some(
          (x: any) => x.reason === "not_started_call_budget",
        ),
      );
      assert.equal(
        e.coverage.analyzedChunks +
          e.coverage.failedChunks +
          e.coverage.notStartedChunks,
        e.coverage.plannedChunks,
      );
      return true;
    },
  );
});

test("cache corruption is revalidated, runner mismatch is rejected, and unknown engine cannot select a fallback", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    calls: any[] = [],
    store = new Map<string, any>(),
    cache = {
      get: (k: string) => store.get(k),
      set: (k: string, v: any) => {
        store.set(k, v);
      },
    };
  const args = {
    snapshot: s,
    providerId: "codex" as const,
    model: "chosen",
    scope: { kind: "pr" } as const,
    runner: fixtureRunner(s, calls),
    cache,
  };
  await runPipeline(args);
  let n = calls.length;
  for (const entry of store.values())
    if (entry.output.taskId) entry.output.summary.evidenceIds = ["fake"];
  const again = await runPipeline(args);
  assert.ok(calls.length > n);
  assert.equal(again.output.analysisStatus, "complete");
  await assert.rejects(
    runPipeline({
      ...args,
      cache: undefined,
      runner: async (r: any) => {
        const result = await fixtureRunner(s, [])(r);
        result.metadata.providerId = "claude";
        return result;
      },
    }),
    /all_chunks_failed/,
  );
  await assert.rejects(
    runPipeline({ ...args, providerId: "unknown" as any }),
    /explicit provider/,
  );
});

test("returned exact validation context supports cached reload and excludes invented synthesis evidence", async (t) => {
  const s = await sample(t),
    { runPipeline, validateV3Output } = await api(),
    result = await runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner: fixtureRunner(s, []),
    });
  assert.ok(result.validationContext);
  assert.doesNotThrow(() =>
    validateV3Output(
      JSON.parse(JSON.stringify(result.output)),
      s,
      JSON.parse(JSON.stringify(result.validationContext)),
    ),
  );
  const base = fixtureRunner(s, []);
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner: async (r: any) => {
        const out = await base(r);
        if (r.stage === "synthesis")
          out.output.codeExplanations[0].roleInPR.evidenceIds = ["invented"];
        return out;
      },
    }),
    /synthesis_failed/,
  );
});

test("tour cross-payload requirement validation occurs before cache persistence", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    base = fixtureRunner(s, []),
    saved: any[] = [];
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "chosen",
    scope: { kind: "pr" },
    cache: {
      get: () => undefined,
      set: (_k, v) => {
        saved.push(v);
      },
    },
    runner: async (r: any) => {
      const out = await base(r);
      if (r.stage === "tour")
        out.output.tour.steps[0].requirementIds = ["unknown"];
      return out;
    },
  });
  assert.equal(result.output.analysisStatus, "partial");
  assert.equal(result.output.tour.steps.length, 0);
  assert.ok(!saved.some((x) => x.output.tour));
});

test("tour insufficient_context is not reduced to synthesis partial", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    base = fixtureRunner(s, []);
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "chosen",
    scope: { kind: "pr" },
    runner: async (r: any) => {
      const out = await base(r);
      if (r.stage === "synthesis") {
        out.output.analysisStatus = "partial";
        out.output.limitations = [unknown()];
      }
      if (r.stage === "tour") {
        out.output.analysisStatus = "insufficient_context";
        out.output.limitations = [unknown()];
      }
      return out;
    },
  });
  assert.equal(result.output.analysisStatus, "insufficient_context");
});

test("transport evidence accounting includes failed calls and distinguishes cached reuse from new transmission", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    calls: any[] = [],
    store = new Map<string, any>(),
    base = fixtureRunner(s, calls),
    cache = {
      get: (k: string) => store.get(k),
      set: (k: string, v: any) => {
        store.set(k, v);
      },
    };
  const args = {
    snapshot: s,
    providerId: "codex" as const,
    model: "chosen",
    scope: { kind: "pr" } as const,
    cache,
    runner: base,
  };
  const result = await runPipeline(args),
    sent = [
      ...new Set(
        calls.flatMap((c) => [
          ...c.context.bundle.code.map((x: any) => x.evidence.id),
          ...c.context.bundle.sources.map((e: any) => e.id),
        ]),
      ),
    ].sort();
  assert.deepEqual(
    [...result.coverage.currentRunTransmittedEvidenceIds].sort(),
    sent,
  );
  const again = await runPipeline(args);
  assert.deepEqual(again.coverage.currentRunTransmittedEvidenceIds, []);
  assert.deepEqual([...again.coverage.transmittedEvidenceIds].sort(), sent);
  const failedCalls: any[] = [],
    failed = fixtureRunner(s, failedCalls);
  let first = true;
  const partial = await runPipeline({
    ...args,
    cache: undefined,
    runner: async (r: any) => {
      const result = await failed(r);
      if (first) {
        first = false;
        throw Error("scripted first failure");
      }
      return result;
    },
  });
  for (const e of failedCalls[0].context.bundle.code)
    assert.ok(
      partial.coverage.currentRunTransmittedEvidenceIds.includes(e.evidence.id),
    );
});
