import { fakeEngineSetup } from "./fake-engine-setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import {
  richSnapshot,
  richSnapshotThreeCommits,
  richRunner,
} from "./integration-v3-fixture.ts";
import type { LiveSnapshot } from "../src/server/analysis-v3/index.ts";

// Deterministic FAKE JSON runner only. Actual API, planner, validators and
// store; no real accounts, CLI inference, target execution or source reads.
async function runPR(
  t: { after: (fn: () => void) => void },
  s: LiveSnapshot,
) {
  const calls: any[] = [];
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-v3-summaries-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = new LiveAPI({
    dataDir: root,
    engineSetup: fakeEngineSetup(),
    runner: richRunner(s, calls),
  } as any);
  t.after(() => api.close());
  const request = (p: string, method = "GET", body: any = {}) =>
    api.handle(method, new URL("http://127.0.0.1:4317" + p), body);
  await request("/api/connections", "POST", {
    id: s.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "fixture",
    auth: { kind: "public" },
  });
  api.store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  const start = await request("/api/live/run", "POST", {
    snapshotId: s.snapshotId,
    providerId: "codex",
    model: "FAKE-fixture-not-inference",
    scope: { kind: "pr" },
    consent: true,
  });
  const id = (start!.data as any).id;
  for (let i = 0; i < 300; i++) {
    const j = api.jobs.get(id)!.job;
    if (!["queued", "running"].includes(j.status)) return { job: j, calls };
    await new Promise((r) => setTimeout(r, 5));
  }
  throw Error("bounded fixture job timeout");
}

test("three-commit PR retains per-commit phase summaries and a shared change group after validation", async (t) => {
  const s = await richSnapshotThreeCommits(t),
    { job, calls } = await runPR(t, s);
  assert.equal(job.status, "succeeded", job.error);
  assert.ok(calls.filter((c) => c.stage === "synthesis").length === 1);
  const output = (job.result as any).output;
  assert.equal(output.analysisStatus, "complete");
  assert.equal(s.phases.length, 3);
  for (const phase of s.phases) {
    const summary = output.phaseSummaries.find(
      (x: any) => x.commitSha === phase.sha,
    );
    assert.ok(summary, "phase summary missing for commit " + phase.sha);
    assert.equal(summary.comparisonFromSha, phase.comparisonFromSha);
    for (const key of [
      "title",
      "before",
      "changes",
      "why",
      "limitationsOfPhase",
    ] as const)
      assert.equal(summary[key].kind, "observed");
    assert.ok(summary.focusFileIds.length);
  }
  const group = output.changeGroups.find((x: any) => x.id === "group:fixture");
  assert.ok(group, "shared change group missing after validation");
  assert.equal(group.commitShas.length, 2);
  assert.ok(group.fileIds.length && group.evidenceIds.length);
  assert.equal(output.tour.tourRevisionSha, s.headSha);
});

test("existing rich snapshot still completes through the same pipeline", async (t) => {
  const s = await richSnapshot(t),
    { job } = await runPR(t, s);
  assert.equal(job.status, "succeeded", job.error);
  assert.equal((job.result as any).output.analysisStatus, "complete");
});
