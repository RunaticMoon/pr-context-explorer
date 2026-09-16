import { fakeEngineSetup } from "./fake-engine-setup.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { objectFixture } from "./core-review-helpers.ts";
import { fixtureRunner } from "./analysis-v3-fixtures.test.ts";
test("core jobs persist snapshots, reuse scope/model cache only, and Jira candidate edits remain local", async (t) => {
  const { LiveAPI } = await import("../src/server/live-api.ts");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "prce-core-")));
  // V3 uses the live collector's actual immutable proof shape, not a cast
  // of the separate demo contract. Runner JSON is still explicitly FAKE.
  const f = objectFixture(t);
  const base = f.commit({ "a.ts": "export const n = 1;\n" });
  const head = f.commit(
    { "a.ts": "export const n = 2;\n" },
    [base],
    "DEMO-1 requirement candidate",
  );
  const s = await f.collect(base, head);
  s.coverage.complete = false;
  const calls: any[] = [];
  const api = new LiveAPI({
    dataDir: root,
    engineSetup: fakeEngineSetup(),
    ingest: async () => structuredClone(s),
    runner: fixtureRunner(s, calls),
  });
  const request = (route: string, method = "GET", body: any = {}) =>
    api.handle(method, new URL("http://127.0.0.1:4317" + route), body);
  const finish = async (id: string) => {
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const job = api.jobs.get(id)!.job;
      if (!["queued", "running"].includes(job.status)) return job;
    }
    throw Error("job did not finish");
  };
  try {
    await request("/api/connections", "POST", {
      id: s.connectionId,
      type: "github",
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
      apiVersion: "2022-11-28",
      account: "public",
      auth: { kind: "public" },
    });
    const started = await request("/api/live/snapshots", "POST", {
      connectionId: s.connectionId,
      url: s.pr.url,
    });
    assert.equal(started?.status, 202);
    const job = await finish((started!.data as any).id);
    assert.equal(job.status, "partial");
    assert.equal(
      (await request("/api/live/snapshot?id=" + s.snapshotId))?.status,
      200,
    );
    const payload = {
      snapshotId: s.snapshotId,
      providerId: "codex",
      model: "fixture-model",
      scope: { kind: "pr" },
      consent: true,
    };
    const analysis = await request("/api/live/run", "POST", payload);
    const analyzed = await finish((analysis!.data as any).id);
    assert.equal(analyzed.processStatus, "succeeded", analyzed.error);
    assert.equal(analyzed.analysisStatus, "partial");
    const callCount = calls.length;
    assert.ok(callCount > 1);
    assert.equal(
      (await request("/api/live/run", "POST", payload))!.status,
      200,
    );
    assert.equal(calls.length, callCount);
    await request("/api/jira/settings", "POST", {
      connections: [],
      projectHosts: {},
    });
    const discovery = await request("/api/jira/candidates", "POST", {
      snapshotId: s.snapshotId,
    });
    assert.ok(
      (discovery!.data as any).candidates.some((c: any) => c.key === "DEMO-1"),
    );
    const candidate = (discovery!.data as any).candidates[0];
    const excluded = await request("/api/jira/candidates/edit", "POST", {
      snapshotId: s.snapshotId,
      candidateId: candidate.id,
      excluded: true,
    });
    assert.equal((excluded!.data as any).candidates[0].excluded, true);
  } finally {
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
