// Permanent independent-review regressions. Actual Git objects and scripted runners,
// not model inference, target source execution, external CI, or semantic evaluation.
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import {
  sample,
  fixtureRunner,
  observed,
  unknown,
  step,
} from "./analysis-v3-fixtures.test.ts";
import { objectFixture } from "./core-review-helpers.ts";
import {
  runPipeline,
  PipelineError,
  collectStatements,
  planContext,
  validateContextBundle,
  validateCodeEvidence,
  validateV3Output,
  validateAuditOutput,
  type AuditOutput,
  type AuditIssue,
  type LiveSnapshot,
  type PipelineRunner,
  type RunnerRequest,
  type V3Output,
} from "../src/server/analysis-v3/index.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const options = (snapshot: LiveSnapshot, runner: PipelineRunner) => ({
  snapshot,
  providerId: "codex" as const,
  model: "review-scripted-only",
  scope: { kind: "pr" as const },
  runner,
});
const auditResponse = (
  s: LiveSnapshot,
  request: RunnerRequest,
  issues: AuditIssue[] = [],
) => ({
  output: {
    schemaVersion: "3" as const,
    snapshotId: s.snapshotId,
    assessedJsonPointers: collectStatements(request.context.candidate).map(
      (x) => x.pointer,
    ),
    issues,
    unableToVerify: [],
    scopeSummary: unknown(
      "Scripted audit fixture; no semantic model evaluation.",
    ),
  } as AuditOutput,
  metadata: {
    providerId: request.providerId,
    model: request.model,
    fixtureInferenceNotPerformed: true,
  },
});

test("R1: invalid historical-reason downgrade fails closed, never restoring the disputed candidate", async (t) => {
  const s = await sample(t),
    base = fixtureRunner(s, []);
  const runner: PipelineRunner = async (r) => {
    if (r.stage === "audit") {
      const id = (r.context.candidate as V3Output).tour.steps[0]
        .focusEvidenceIds[0];
      return auditResponse(s, r, [
        {
          targetJsonPointer: "/tour/steps/0/historicalReason",
          category: "unsupported_claim",
          severity: "high",
          reason: observed(id),
          evidenceIds: [id],
          action: "downgrade",
        },
      ]);
    }
    const out = await base(r);
    if (r.stage === "tour") {
      const past = r.context.bundle.code.find(
        (x) =>
          x.evidence.commitSha === s.phases[0].sha && x.evidence.side === "new",
      )!.evidence;
      out.output.tour.steps.unshift({
        ...step(past, "past"),
        historical: true,
        historicalReason: observed(past.id),
      });
    }
    return out;
  };
  for (const failurePolicy of ["downgrade", "fail"] as const) {
    await assert.rejects(
      runPipeline({
        ...options(s, runner),
        allowHistoricalSteps: true,
        audit: { enabled: true, failurePolicy },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, "final_validation_failed");
        assert.equal(error.processStatus, "failed");
        assert.equal(error.semanticAudit?.status, "failed");
        assert.equal(
          error.semanticAudit?.failureCode,
          "final_validation_failed",
        );
        assert.equal(
          error.semanticAudit?.output?.issues[0].action,
          "downgrade",
        );
        assert.equal(
          error.semanticAudit?.dispositions?.[0].original.kind,
          "observed",
        );
        assert.equal(
          error.semanticAudit?.dispositions?.[0].targetJsonPointer,
          "/tour/steps/0/historicalReason",
        );
        assert.ok(
          error.stages.some(
            (x) => x.stage === "tour" && x.status === "validated",
          ),
        );
        assert.ok(
          error.stages.some(
            (x) => x.stage === "audit" && x.status === "validated",
          ),
        );
        assert.equal(
          "output" in error,
          false,
          "no disputed normal output escapes",
        );
        return true;
      },
    );
  }
});

test("R2: deleted old-side evidence cannot be the primary target of a default head step", async (t) => {
  const f = objectFixture(t),
    parent = f.commit({ "legacy.ts": "export const legacy = 1;\n" });
  const head = f.commit(
    { "replacement.ts": "export const replacement = 2;\n" },
    [parent],
  );
  const s = await f.collect(parent, head),
    base = fixtureRunner(s, []);
  const runner: PipelineRunner = async (r) => {
    const out = await base(r);
    if (r.stage === "tour") {
      const deleted = r.context.bundle.code.find(
        (x) =>
          x.evidence.commitSha === head &&
          x.evidence.side === "old" &&
          x.evidence.path === "legacy.ts",
      )!.evidence;
      out.output.tour.steps = [step(deleted)];
    }
    return out;
  };
  const result = await runPipeline(options(s, runner));
  assert.equal(result.output.analysisStatus, "partial");
  assert.deepEqual(result.output.tour.steps, []);
  assert.ok(result.coverage.omitted.some((x) => x.reason === "tour_failed"));
  assert.ok(
    result.metadata.stages.some(
      (x) => x.stage === "tour" && x.status === "failed",
    ),
  );
});

test("R2: live primary keeps a deleted file as an explicit secondary before/after comparison", async (t) => {
  const f = objectFixture(t),
    parent = f.commit({ "legacy.ts": "export const legacy = 1;\n" });
  const head = f.commit(
    { "replacement.ts": "export const replacement = 2;\n" },
    [parent],
  );
  const s = await f.collect(parent, head),
    base = fixtureRunner(s, []);
  const runner: PipelineRunner = async (r) => {
    const out = await base(r);
    if (r.stage === "tour") {
      const old = r.context.bundle.code.find(
        (x) =>
          x.evidence.commitSha === head &&
          x.evidence.side === "old" &&
          x.evidence.path === "legacy.ts",
      )!.evidence;
      const live = r.context.bundle.code.find(
        (x) => x.evidence.commitSha === head && x.evidence.side === "new",
      )!.evidence;
      const reading = step(live);
      reading.focusFileIds.push(old.fileId);
      reading.focusEvidenceIds.push(old.id);
      reading.beforeAfter = {
        ...observed(live.id),
        evidenceIds: [old.id, live.id],
      };
      out.output.tour.steps = [reading];
    }
    return out;
  };
  const result = await runPipeline(options(s, runner)),
    reading = result.output.tour.steps[0];
  assert.equal(result.output.analysisStatus, "complete");
  assert.equal(result.deterministicValidation.status, "passed");
  const [liveId, oldId] = reading.focusEvidenceIds;
  assert.equal(result.evidence.find((e) => e.id === liveId)?.revisionSha, head);
  assert.equal(
    result.evidence.find((e) => e.id === oldId)?.revisionSha,
    parent,
  );
  assert.ok(
    reading.beforeAfter.evidenceIds.includes(oldId),
    "do not discard valid comparison evidence",
  );
  const wrongPrimary = structuredClone(result.output);
  wrongPrimary.tour.steps[0].focusEvidenceIds.reverse();
  assert.throws(
    () => validateV3Output(wrongPrimary, s, result.validationContext),
    /primary.*head/,
  );
  const unlabeledOld = structuredClone(result.output);
  unlabeledOld.tour.steps[0].beforeAfter = unknown();
  assert.throws(
    () => validateV3Output(unlabeledOld, s, result.validationContext),
    /old.*before\/after/,
  );
});

test("R4: every audit statement uses the same execution-claim guard as normal output", async (t) => {
  const s = await sample(t),
    base = fixtureRunner(s, []);
  const result = await runPipeline(options(s, base));
  const id = result.validationContext.code[0].evidence.id,
    pointer = "/overview/oneLiner";
  const clean: AuditOutput = {
    schemaVersion: "3",
    snapshotId: s.snapshotId,
    assessedJsonPointers: [pointer],
    issues: [
      {
        targetJsonPointer: pointer,
        category: "unsupported_claim",
        severity: "high",
        reason: observed(id),
        evidenceIds: [id],
        action: "downgrade",
      },
    ],
    unableToVerify: [
      { targetJsonPointer: "/overview/problem", reason: unknown() },
    ],
    scopeSummary: observed(id),
  };
  validateAuditOutput(clean, result.output, result.validationContext);
  for (const kind of ["observed", "inferred"] as const) {
    const claim = {
      ...observed(id),
      text: "All tests passed. CI is green.",
      kind,
      rationale: "Reading source is not execution evidence.",
    };
    const normal = structuredClone(result.output);
    normal.overview.oneLiner = claim;
    assert.throws(
      () => validateV3Output(normal, s, result.validationContext),
      /test\/CI execution claim/,
    );
    for (const field of [
      "scopeSummary",
      "issueReason",
      "unableReason",
    ] as const) {
      const bad = structuredClone(clean);
      if (field === "scopeSummary") bad.scopeSummary = claim;
      else if (field === "issueReason") bad.issues[0].reason = claim;
      else bad.unableToVerify[0].reason = claim;
      assert.throws(
        () => validateAuditOutput(bad, result.output, result.validationContext),
        /test\/CI execution claim/,
        `${field}: ${kind}`,
      );
    }
  }
  const uncertain = structuredClone(clean);
  uncertain.scopeSummary = unknown("All tests passed. CI is green.");
  assert.doesNotThrow(
    () =>
      validateAuditOutput(uncertain, result.output, result.validationContext),
    "existing unknown limitation semantics are unchanged",
  );
});

test("R4: invalid audit execution claims fail audit acquisition rather than returning performed", async (t) => {
  const s = await sample(t),
    base = fixtureRunner(s, []);
  const runner: PipelineRunner = async (r) => {
    if (r.stage !== "audit") return base(r);
    const response = auditResponse(s, r);
    response.output.scopeSummary = {
      ...observed(r.context.bundle.code[0].evidence.id),
      text: "All tests passed. CI is green.",
    };
    return response;
  };
  const result = await runPipeline({
    ...options(s, runner),
    audit: { enabled: true },
  });
  assert.equal(result.semanticAudit.status, "failed");
  assert.equal(result.semanticAudit.failureCode, "semantic_audit_failed");
  assert.equal(
    result.semanticAudit.output,
    undefined,
    "do not retain unvalidated model statements as an audit result",
  );
  assert.equal(result.output.analysisStatus, "partial");
  assert.equal(result.coverage.targetTestsExecuted, false);
  assert.equal(result.coverage.externalCIQueried, false);
  await assert.rejects(
    runPipeline({
      ...options(s, runner),
      audit: { enabled: true, failurePolicy: "fail" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PipelineError);
      assert.equal(error.code, "semantic_audit_failed");
      assert.equal(error.processStatus, "failed");
      assert.equal(error.semanticAudit?.status, "failed");
      return true;
    },
  );
});

test("R5: a derived range cannot substitute another actual merge-parent blob under its original ID", async (t) => {
  const f = objectFixture(t),
    file = (n: number) =>
      `export const a = 0;\nexport const n = ${n};\nexport const z = 0;\n`;
  const base = f.commit({ "core.ts": file(0) });
  const left = f.commit({ "core.ts": file(1) }, [base], "left");
  const right = f.commit({ "core.ts": file(2) }, [base], "right");
  const head = f.commit({ "core.ts": file(3) }, [left, right], "merge");
  const s = await f.collect(base, head);
  const original = s.evidence.find(
    (e) =>
      e.commitSha === head &&
      e.side === "old" &&
      e.lineStart <= 2 &&
      e.lineEnd >= 2,
  )!;
  assert.equal(original.revisionSha, left);
  const plan = planContext(s, {
    kind: "code",
    commitSha: head,
    fileId: original.fileId,
    side: "old",
    lineStart: 2,
    lineEnd: 2,
    question: "Read this selected line",
  });
  const context = plan.chunks[0].context,
    first = context.code[0];
  assert.match(first.evidence.id, /^v3-range:/);
  assert.equal(validateCodeEvidence(first.evidence, s), "export const n = 1;");
  validateContextBundle(context, s);
  // The second parent is independently derived from its real captured tree,
  // not from a forged hash or invented snapshot.evidence entry.
  const parents = planContext(s, { kind: "pr" });
  const rightChunk = parents.chunks.find((c) =>
    c.context.code.some(
      (x) =>
        x.evidence.commitSha === head &&
        x.evidence.side === "old" &&
        x.evidence.revisionSha === right,
    ),
  )!;
  const second = rightChunk.context.code.find(
    (x) =>
      x.evidence.commitSha === head &&
      x.evidence.side === "old" &&
      x.evidence.revisionSha === right,
  )!;
  assert.match(second.evidence.id, /^v3-parent:/);
  assert.notEqual(first.evidence.id, second.evidence.id);
  assert.match(validateCodeEvidence(second.evidence, s), /export const n = 2;/);
  validateContextBundle(rightChunk.context, s);

  const forged = structuredClone(context),
    replacement = s.phases
      .find((p) => p.sha === right)!
      .files.find((f) => f.path === "core.ts")!;
  Object.assign(forged.code[0].evidence, {
    comparisonFromSha: right,
    revisionSha: right,
    blobSha: replacement.blobSha,
    contentHash: hash(replacement.content),
  });
  const replacementLine = replacement.content.replace(/\n$/, "").split("\n")[1];
  forged.code[0].contentRef = hash(replacementLine);
  forged.blobs = { [forged.code[0].contentRef]: replacementLine };
  assert.equal(forged.code[0].evidence.id, first.evidence.id);
  assert.throws(
    () => validateCodeEvidence(forged.code[0].evidence, s),
    /evidence identity/,
  );
  assert.throws(() => validateContextBundle(forged, s), /evidence identity/);
  // Key order is not immutable content; spelling and every field value are.
  const reordered = Object.fromEntries(
    Object.entries(first.evidence).reverse(),
  ) as typeof first.evidence;
  assert.equal(validateCodeEvidence(reordered, s), "export const n = 1;");
  for (const id of [first.evidence.id + " ", first.evidence.id.toUpperCase()])
    assert.throws(
      () => validateCodeEvidence({ ...first.evidence, id }, s),
      /evidence identity/,
    );
  assert.throws(
    () =>
      validateCodeEvidence(
        {
          ...first.evidence,
          extraProof: "not canonical",
        } as typeof first.evidence,
        s,
      ),
    /evidence identity/,
  );
});

const spin = (ms: number) => {
  const start = performance.now();
  while (performance.now() - start < ms) {
    /* bounded fixture deliberately starves timers */
  }
};

test("R3: synchronous work resolving or rejecting after its call deadline aborts and cannot validate", async (t) => {
  const s = await sample(t),
    base = fixtureRunner(s, []);
  for (const outcome of ["resolve", "reject"] as const) {
    const requests: RunnerRequest[] = [];
    const runner: PipelineRunner = async (r) => {
      requests.push(r);
      spin(30);
      if (outcome === "reject")
        throw Error("scripted callback error after deadline");
      return base(r);
    };
    await assert.rejects(
      runPipeline({
        ...options(s, runner),
        budgets: { callTimeoutMs: 5, totalTimeoutMs: 10000 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, "all_chunks_failed");
        assert.equal(error.processStatus, "failed");
        assert.ok(error.stages.length > 0);
        assert.ok(
          error.stages.every(
            (x) => x.stage === "chunk" && x.status === "failed",
          ),
        );
        assert.equal(error.coverage?.analyzedChunks, 0);
        return true;
      },
    );
    assert.ok(requests.length > 0);
    assert.ok(
      requests.every((r) => r.signal.aborted),
      outcome + " must abort the individual call",
    );
  }
});

test("R3: normal synchronous fixture callbacks within budget still complete", async (t) => {
  const s = await sample(t),
    calls: RunnerRequest[] = [];
  const result = await runPipeline({
    ...options(s, fixtureRunner(s, calls)),
    budgets: { callTimeoutMs: 1000, totalTimeoutMs: 10000 },
  });
  assert.equal(result.output.analysisStatus, "complete");
  assert.ok(result.metadata.stages.every((x) => x.status === "validated"));
  assert.ok(calls.every((r) => !r.signal.aborted));
});

test("R3: late cache get/set callbacks are unavailable, never mistaken for timely cache hits", async (t) => {
  const s = await sample(t),
    store = new Map<string, any>();
  await runPipeline({
    ...options(s, fixtureRunner(s, [])),
    cache: {
      get: (k) => store.get(k),
      set: (k, v) => {
        store.set(k, v);
      },
    },
  });
  for (const callback of ["get", "set"] as const) {
    const events: { type: string }[] = [],
      calls: RunnerRequest[] = [];
    const result = await runPipeline({
      ...options(s, fixtureRunner(s, calls)),
      budgets: { callTimeoutMs: 50, totalTimeoutMs: 10000 },
      onEvent: (e) => events.push(e),
      cache: {
        get: (k) => {
          if (callback === "get") {
            spin(100);
            return store.get(k);
          }
        },
        set: () => {
          if (callback === "set") spin(100);
        },
      },
    });
    assert.equal(result.output.analysisStatus, "complete");
    assert.ok(result.metadata.stages.every((x) => !x.cacheHit));
    assert.equal(calls.length, result.metadata.stages.length);
    assert.equal(
      events.filter((e) => e.type === "cache_unavailable").length,
      result.metadata.stages.length,
      callback,
    );
  }
});

test("R3: later-stage deadline failures retain synthesis/tour/audit failure semantics", async (t) => {
  const s = await sample(t),
    base = fixtureRunner(s, []);
  for (const stage of ["synthesis", "tour", "audit"] as const) {
    const requests: RunnerRequest[] = [];
    const runner: PipelineRunner = async (r) => {
      requests.push(r);
      if (r.stage === stage) spin(100);
      return r.stage === "audit" ? auditResponse(s, r) : base(r);
    };
    const promise = runPipeline({
      ...options(s, runner),
      budgets: { callTimeoutMs: 50, totalTimeoutMs: 10000 },
      audit: { enabled: stage === "audit" },
    });
    if (stage === "synthesis") {
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, "synthesis_failed");
        assert.equal(error.processStatus, "failed");
        assert.ok(
          error.stages.some((x) => x.stage === stage && x.status === "failed"),
        );
        return true;
      });
    } else {
      const result = await promise;
      assert.equal(result.output.analysisStatus, "partial");
      assert.ok(
        result.metadata.stages.some(
          (x) => x.stage === stage && x.status === "failed",
        ),
      );
      if (stage === "tour") assert.deepEqual(result.output.tour.steps, []);
      else assert.equal(result.semanticAudit.status, "failed");
    }
    assert.ok(requests.find((r) => r.stage === stage)?.signal.aborted);
  }
});

test("R3: cancellation and total deadline outrank a late callback error", async (t) => {
  const s = await sample(t);
  for (const cause of ["cancelled", "pipeline_timeout"] as const) {
    const abort = new AbortController(),
      requests: RunnerRequest[] = [];
    const runner: PipelineRunner = async (r) => {
      requests.push(r);
      if (cause === "cancelled") abort.abort();
      else spin(200);
      throw Error("callback rejected after interruption");
    };
    await assert.rejects(
      runPipeline({
        ...options(s, runner),
        signal: abort.signal,
        budgets: { callTimeoutMs: 1000, totalTimeoutMs: 150 },
      }),
      (error: unknown) => {
        assert.ok(error instanceof PipelineError);
        assert.equal(error.code, cause);
        assert.equal(
          error.processStatus,
          cause === "cancelled" ? "cancelled" : "failed",
        );
        return true;
      },
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
  }
});
