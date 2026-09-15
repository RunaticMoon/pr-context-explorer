import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI } from "../src/server/live-api.ts";
import { sample, fixtureRunner } from "./analysis-v3-fixtures.test.ts";

// Deterministic FAKE JSON runner only. Actual API, planner, validators and store;
// no real accounts, CLI inference, target execution or extra source reads.
export async function finish(api: LiveAPI, id: string) {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 5));
    const j = api.jobs.get(id)!.job;
    if (!["queued", "running"].includes(j.status)) return j;
  }
  throw Error("bounded fixture job timeout");
}
test("default Live API runs V3 chunk→synthesis→head tour and persists full validated provenance", async (t) => {
  const s = await sample(t),
    calls: any[] = [];
  const root = mkdtempSync(path.join(tmpdir(), "prce-v3-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const api = new LiveAPI({
    dataDir: root,
    runner: fixtureRunner(s, calls),
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
  const payload = {
    snapshotId: s.snapshotId,
    providerId: "codex",
    model: "FAKE-fixture-not-inference",
    scope: { kind: "pr" },
    consent: true,
  };
  const start = await request("/api/live/run", "POST", payload);
  const j = await finish(api, (start!.data as any).id);
  assert.equal(j.status, "succeeded", j.error);
  assert.ok(calls.filter((c) => c.stage === "chunk").length > 1);
  assert.equal(calls.filter((c) => c.stage === "synthesis").length, 1);
  const r = j.result as any;
  assert.equal(r.output.schemaVersion, "3");
  assert.equal(r.output.tour.tourRevisionSha, s.headSha);
  assert.equal(r.output.codeExplanations[0].roleInPR.kind, "observed");
  assert.ok(r.validationContext.code.length);
  assert.ok(api.store.list("chunk" as any).length > 1);
  const saved = (await request("/api/live/analysis?key=" + r.cacheKey))!
    .data as any;
  assert.deepEqual(saved.result.output, r.output);
  assert.equal(saved.result.semanticAudit.status, "not_performed");
  const count = calls.length;
  const cached = (await request("/api/live/run", "POST", payload))!.data as any;
  assert.equal(cached.cached, true);
  assert.equal(calls.length, count);
  assert.deepEqual(cached.result.output, r.output);
});
