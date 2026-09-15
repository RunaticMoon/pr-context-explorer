import { test } from "node:test";
import assert from "node:assert/strict";
import { collect, hash } from "../src/server/git.ts";
test("real-provider schema validates mixed source evidence, inferred rationale, immutable refs and restricted code context", async () => {
  const { validateLiveOutput, buildContext } =
    await import("../src/server/live-analysis.ts");
  const demo = collect();
  const s = {
    ...demo,
    mode: "live",
    sourceEvidence: [
      {
        id: "pr:body",
        sourceKind: "pr",
        snapshotId: demo.snapshotId,
        sourceId: "pr",
        contentHash: hash(demo.pr.body),
        version: hash(demo.pr.body),
        fieldPath: "/body",
        text: demo.pr.body,
      },
    ],
    jiraSnapshotHashes: [],
  } as any;
  const e = s.evidence.find(
    (e: any) =>
      e.commitSha === s.headSha &&
      e.side === "new" &&
      e.path === "src/process.ts",
  );
  const output = {
    schemaVersion: "2",
    snapshotId: s.snapshotId,
    analysisStatus: "partial",
    limitations: ["Static only"],
    missingContext: ["CI"],
    statements: [
      {
        text: "Observed input normalization",
        kind: "observed",
        confidence: "medium",
        limitation: "",
        commitSha: s.headSha,
        evidenceIds: [e.id, "pr:body"],
      },
    ],
    steps: [
      {
        id: "one",
        title: "Read contract",
        why: "Understand policy",
        previous: "",
        next: "",
        question: "Check errors?",
        beforeAfter: "Review before/after",
        revisionSha: s.headSha,
        comparisonFromSha: e.comparisonFromSha,
        fileIds: [e.fileId],
        evidenceIds: [e.id],
        prerequisites: [],
        requirementIds: [],
      },
    ],
    requirementMappings: [],
    codeExplanations: [],
  };
  validateLiveOutput(output, s);
  const bad = structuredClone(output);
  bad.statements[0].evidenceIds = ["absent"];
  assert.throws(() => validateLiveOutput(bad, s), /evidence/);
  const inferred = structuredClone(output);
  inferred.statements[0].kind = "inferred";
  assert.throws(() => validateLiveOutput(inferred, s), /rationale/);
  const truthful=structuredClone(output);truthful.statements[0].text='대상 테스트를 실행하지 않았으며 테스트 통과 여부는 확인되지 않았습니다.';validateLiveOutput(truthful,s);
  const claim = structuredClone(output);
  claim.statements[0].text = "All tests passed";
  assert.throws(() => validateLiveOutput(claim, s), /execution/);
  const source = structuredClone(s);
  source.sourceEvidence[0].text = "forged";
  assert.throws(() => validateLiveOutput(output, source), /source/);
  const context = buildContext(s, {
    kind: "code",
    commitSha: s.headSha,
    fileId: e.fileId,
    side: "new",
    lineStart: 2,
    lineEnd: 3,
    question: "Why changed?",
  });
  assert.equal(context.headSha, s.headSha);
  assert.equal(context.baseSha, s.baseSha);
  assert.equal(context.code[0].content.split("\n").length, 2);
  assert.equal(context.code[0].lineStart, 2);
  assert.equal(context.code.length, 1);
  assert.ok(!JSON.stringify(context).includes("function normalize"));
  assert.throws(
    () =>
      buildContext(s, {
        kind: "code",
        commitSha: s.headSha,
        fileId: e.fileId,
        side: "new",
        lineStart: 0,
        lineEnd: 3,
        question: "Why?",
      }),
    /range/,
  );
});
