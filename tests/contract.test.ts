import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { collect } from "../src/server/git.ts";
test("MockProvider 계약과 위조 근거/주장/투어 참조 거부", async () => {
  assert.ok(existsSync("src/server/contract.ts"), "검증기 구현 필요");
  const { validateAnalysis, validateEvidence } =
    await import("../src/server/contract.ts");
  const { MockProvider, CodexProvider, ClaudeCodeProvider } =
    await import("../src/server/provider.ts");
  const s = collect();
  const a = await new MockProvider().analyze(s);
  validateAnalysis(a, s);
  assert.equal(new CodexProvider().capability().available, false);
  assert.equal(new ClaudeCodeProvider().capability().available, false);
  for (const patch of [
    { snapshotId: "fake" },
    { revisionSha: "f".repeat(40) },
    { path: "../secret" },
    { blobSha: "0".repeat(40) },
    { lineStart: 0 },
    { lineEnd: 9999 },
    { side: "context" },
    { comparisonFromSha: "fake" },
  ]) {
    assert.throws(() =>
      validateEvidence({ ...s.evidence[0], ...patch } as any, s),
    );
  }
  for (const mutate of [
    (x: any) => (x.extra = true),
    (x: any) => (x.snapshotId = "bad"),
    (x: any) => (x.statements[0].evidenceIds = []),
    (x: any) => (x.statements[0].evidenceIds = ["missing"]),
    (x: any) => (x.steps[0].fileIds = ["missing"]),
    (x: any) => (x.steps[0].revisionSha = s.baseSha),
    (x: any) => (x.steps[0].prerequisites = [x.steps[0].id]),
    (x: any) => (x.steps[1].id = x.steps[0].id),
  ]) {
    const x = structuredClone(a);
    mutate(x);
    assert.throws(() => validateAnalysis(x, s));
  }
});
