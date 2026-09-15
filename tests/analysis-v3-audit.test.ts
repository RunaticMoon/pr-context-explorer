import test from "node:test";
import assert from "node:assert/strict";
import {
  sample,
  unknown,
  observed,
  fixtureRunner,
} from "./analysis-v3-fixtures.test.ts";
const api = () => import("../src/server/analysis-v3/index.ts");
// Semantic responses here are scripted negative fixtures, NOT semantic model evaluation.
test("opt-in same-engine audit downgrades a plausible but unsupported real-line claim and preserves the issue", async (t) => {
  const s = await sample(t),
    { runPipeline, collectStatements } = await api(),
    calls: any[] = [],
    base = fixtureRunner(s, calls);
  const runner = async (r: any) => {
    if (r.stage !== "audit") return base(r);
    calls.push(r);
    const id = r.context.bundle.code[0].evidence.id;
    return {
      output: {
        schemaVersion: "3",
        snapshotId: s.snapshotId,
        assessedJsonPointers: collectStatements(r.context.candidate).map(
          (x) => x.pointer,
        ),
        issues: [
          {
            targetJsonPointer: "/codeExplanations/0/roleInPR",
            category: "unsupported_claim",
            severity: "high",
            reason: observed(id),
            evidenceIds: [id],
            action: "downgrade",
          },
        ],
        unableToVerify: [],
        scopeSummary: unknown(
          "스크립트 점검 fixture이며 실제 의미 검증이 아니다.",
        ),
      },
      metadata: {
        providerId: r.providerId,
        model: r.model,
        fixtureInferenceNotPerformed: true,
      },
    };
  };
  const result = await runPipeline({
    snapshot: s,
    providerId: "claude",
    model: "selected",
    scope: { kind: "pr" },
    runner,
    audit: { enabled: true },
  });
  assert.equal(calls.filter((c) => c.stage === "audit").length, 1);
  assert.ok(
    calls.every((c) => c.providerId === "claude" && c.model === "selected"),
  );
  assert.equal(result.semanticAudit.status, "performed");
  assert.equal(result.semanticAudit.output!.issues.length, 1);
  assert.equal(result.output.codeExplanations[0].roleInPR.kind, "unknown");
  assert.ok(result.output.codeExplanations[0].roleInPR.limitation);
  assert.equal(result.output.analysisStatus, "partial");
  assert.equal(result.deterministicValidation.semanticSupportVerified, false);
  assert.ok(
    result.semanticAudit.dispositions!.some(
      (d) => d.original.kind === "observed",
    ),
  );
});

test("audit rejects global safe flags and invalid pointers, and explicit rejection prevents normal output", async (t) => {
  const s = await sample(t),
    { runPipeline, collectStatements } = await api(),
    base = fixtureRunner(s, []);
  const runner = async (r: any) => {
    if (r.stage !== "audit") return base(r);
    const id = r.context.bundle.code[0].evidence.id;
    return {
      output: {
        schemaVersion: "3",
        snapshotId: s.snapshotId,
        assessedJsonPointers: collectStatements(r.context.candidate).map(
          (x) => x.pointer,
        ),
        issues: [
          {
            targetJsonPointer: "/codeExplanations/0/roleInPR",
            category: "unsupported_claim",
            severity: "high",
            reason: observed(id),
            evidenceIds: [id],
            action: "reject",
          },
        ],
        unableToVerify: [],
        scopeSummary: unknown(),
      },
      metadata: {},
    };
  };
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "selected",
      scope: { kind: "pr" },
      runner,
      audit: { enabled: true },
    }),
    (e: any) =>
      e.code === "semantic_audit_rejected" &&
      e.semanticAudit.output.issues[0].action === "reject",
  );
  const invalid = async (r: any) => {
    const out = await runner(r);
    if (r.stage === "audit") out.output = { ...out.output, safe: true };
    return out;
  };
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "selected",
    scope: { kind: "pr" },
    runner: invalid,
    audit: { enabled: true },
  });
  assert.equal(result.semanticAudit.status, "failed");
  assert.equal(result.output.analysisStatus, "partial");
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "selected",
      scope: { kind: "pr" },
      runner: invalid,
      audit: { enabled: true, failurePolicy: "fail" },
    }),
    /semantic_audit_failed/,
  );
});

test("unassessed important statements are persisted as unableToVerify rather than silently audited", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api(),
    base = fixtureRunner(s, []);
  const runner = async (r: any) =>
    r.stage !== "audit"
      ? base(r)
      : {
          output: {
            schemaVersion: "3",
            snapshotId: s.snapshotId,
            assessedJsonPointers: [],
            issues: [],
            unableToVerify: [],
            scopeSummary: unknown(),
          },
          metadata: {},
        };
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "selected",
    scope: { kind: "pr" },
    runner,
    audit: { enabled: true },
  });
  assert.ok(result.semanticAudit.output!.unableToVerify.length > 0);
  assert.equal(result.output.analysisStatus, "partial");
});

test("audit downgrade cannot return deterministic passed after its edits overflow the output schema", async (t) => {
  const s = await sample(t),
    { runPipeline, collectStatements } = await api(),
    base = fixtureRunner(s, []);
  const runner = async (r: any) => {
    if (r.stage !== "audit") {
      const v = await base(r);
      if (r.stage === "synthesis")
        v.output.limitations = Array.from({ length: 100 }, () => unknown());
      return v;
    }
    return {
      output: {
        schemaVersion: "3",
        snapshotId: s.snapshotId,
        assessedJsonPointers: [],
        issues: [],
        unableToVerify: [],
        scopeSummary: unknown(),
      },
      metadata: {},
    };
  };
  await assert.rejects(
    runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner,
      audit: { enabled: true },
    }),
    (e: any) =>
      e.code === "final_validation_failed" &&
      !!e.semanticAudit.output &&
      e.semanticAudit.status === "failed",
  );
});

test("even opt-in audit cannot invoke the model without original evidence", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api();
  s.evidence = [];
  s.sourceEvidence = [];
  s.coverage.complete = false;
  s.coverage.unavailable = ["unavailable"];
  let calls = 0;
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "chosen",
    scope: { kind: "pr" },
    runner: async () => {
      calls++;
      throw Error("no evidence");
    },
    audit: { enabled: true },
  });
  assert.equal(calls, 0);
  assert.equal(result.output.analysisStatus, "insufficient_context");
  assert.equal(result.semanticAudit.status, "failed");
});
