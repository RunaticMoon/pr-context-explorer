import { fakeEngineSetup } from "./fake-engine-setup.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LiveAPI, type LiveAPIOptions } from "../src/server/live-api.ts";
import { richSnapshot, richRunner, unknown } from "./integration-v3-fixture.ts";
import { hash } from "../src/server/git.ts";
import type {
  PipelineRunner,
  LiveSnapshot,
} from "../src/server/analysis-v3/types.ts";

async function setup(
  t: any,
  transform?: (r: PipelineRunner, s: LiveSnapshot) => PipelineRunner,
) {
  const s = await richSnapshot(t),
    calls: any[] = [];
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-v3-boundary-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runner = transform?.(richRunner(s, calls), s) || richRunner(s, calls);
  const options: LiveAPIOptions = {
    dataDir: root,
    runner,
    engineSetup: fakeEngineSetup(),
  };
  const api = new LiveAPI(options);
  t.after(() => api.close());
  const request = async (
    p: string,
    method = "GET",
    body: any = {},
  ): Promise<any> =>
    (await api.handle(method, new URL("http://127.0.0.1:4317" + p), body))
      ?.data;
  const connection = {
    id: s.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "FAKE",
    auth: { kind: "public" },
  };
  await request("/api/connections", "POST", connection);
  const save = () =>
    api.store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  save();
  const payload = {
    snapshotId: s.snapshotId,
    providerId: "codex",
    model: "FAKE-model",
    scope: { kind: "pr" },
    consent: true,
  };
  const run = async (extra: any = {}) => {
    const started = await request("/api/live/run", "POST", {
      ...payload,
      ...extra,
    });
    if (started.cached) return { cached: true, result: started.result };
    for (let i = 0; i < 500; i++) {
      await new Promise((r) => setTimeout(r, 5));
      const j = api.jobs.get(started.id)!.job;
      if (!["queued", "running"].includes(j.status)) return j as any;
    }
    throw Error("fixture deadline");
  };
  return { s, calls, api, request, run, options, save, payload, connection };
}

test("API validates cached chunks selectively; exact final context/provenance rechecked on reload; deletion includes chunk retention", async (t) => {
  const x = await setup(t),
    first = await x.run();
  assert.equal(first.status, "succeeded", first.error);
  const n = x.calls.length,
    key = first.result.cacheKey;
  x.api.store.delete("analysis", key);
  const allCached = await x.run();
  assert.equal(x.calls.length, n);
  assert.ok(allCached.result.metadata.stages.every((s: any) => s.cacheHit));
  assert.deepEqual(
    allCached.result.coverage.currentRunTransmittedEvidenceIds,
    [],
  );
  const chunk = x.api.store
    .list<any>("chunk")
    .find((x) => x.value.output.taskId)!;
  chunk.value.output.summary.evidenceIds = ["invented-output-source"];
  x.api.store.put("chunk", chunk.key, chunk.value);
  x.api.store.delete("analysis", key);
  const repaired = await x.run();
  assert.equal(repaired.status, "succeeded", repaired.error);
  assert.equal(x.calls.length, n + 1);
  assert.equal(
    repaired.result.metadata.stages.filter((s: any) => !s.cacheHit).length,
    1,
  );
  const forged = x.api.store.get<any>("analysis", key)!;
  forged.output.codeExplanations[0].targetRevisionSha = x.s.baseline.sha;
  x.api.store.put("analysis", key, forged);
  await assert.rejects(
    x.request("/api/live/analysis?key=" + key),
    /revision|comparison|target/,
  );
  const restored = await x.run();
  assert.equal(restored.status, "succeeded", restored.error);
  const plan = await x.request("/api/live/plan", "POST", {
    snapshotId: x.s.snapshotId,
    scope: { kind: "pr" },
    audit: true,
  });
  assert.equal(plan.auditCalls, 1);
  assert.equal(plan.maxProviderCalls, plan.plannedChunks + 3);
  assert.equal(x.calls.length, n + 1);
  await x.request("/api/live/cache", "DELETE", {
    confirm: "delete-local-cache",
  });
  assert.equal(x.api.store.list("chunk").length, 0);
  assert.equal(x.api.store.list("analysis").length, 0);
  assert.ok(x.api.store.list("config").length);
});

test("real API invalidates source/model/parser/prompt/schema/planner/connection identities rather than trusting cached final output", async (t) => {
  const x = await setup(t);
  let previous = await x.run(),
    n = x.calls.length;
  for (const change of [
    () => {
      x.payload.model = "FAKE-model-v2";
    },
    () => {
      x.s.coverage.parser += ":changed";
      x.save();
    },
    () => {
      x.s.pr.body = "FAKE changed body";
      x.s.prMetadataHash = hash(x.s.pr.body);
      x.s.sourceEvidence = x.s.sourceEvidence.map((e) =>
        e.sourceKind === "pr"
          ? {
              ...e,
              text: e.fieldPath === "/body" ? x.s.pr.body : x.s.pr.title,
              contentHash: hash(
                e.fieldPath === "/body" ? x.s.pr.body : x.s.pr.title,
              ),
              version: x.s.prMetadataHash,
            }
          : e,
      );
      x.save();
    },
    () => {
      x.s.jiraSnapshotHashes = [
        hash("FAKE Jira capture identity dimension; no actual Jira"),
      ];
      x.save();
    },
    ...["prompt", "schema", "planner", "engineFingerprint"].map((key) => () => {
      x.options.versions = { ...x.options.versions, [key]: "FAKE-change" };
    }),
    async () => {
      x.connection.account = "FAKE-other";
      await x.request("/api/connections", "POST", x.connection);
    },
  ]) {
    await change();
    const current = await x.run();
    assert.equal(current.status, "succeeded", current.error);
    assert.notEqual(current.result.cacheKey, previous.result.cacheKey);
    assert.ok(x.calls.length > n);
    n = x.calls.length;
    previous = current;
  }
});

test("audit is explicit same engine additional consent; scoped failed/rejected audit is never semantic verification", async (t) => {
  const x = await setup(t);
  await assert.rejects(x.run({ audit: true }), /audit.*consent/);
  assert.equal(x.calls.length, 0);
  for (const field of [
    "runner",
    "config",
    "versions",
    "command",
    "auth",
    "budgets",
  ])
    await assert.rejects(
      x.run({ [field]: "untrusted" }),
      /unsupported analysis request/,
    );
  const audited = await x.run({ audit: true, auditConsent: true });
  assert.equal(audited.status, "succeeded", audited.error);
  assert.equal(audited.result.semanticAudit.status, "performed");
  assert.equal(audited.result.output.analysisStatus, "partial");
  assert.equal(
    audited.result.deterministicValidation.semanticSupportVerified,
    false,
  );
  assert.equal(x.calls.filter((x) => x.stage === "audit").length, 1);
  assert.ok(
    x.calls.every((x) => x.providerId === "codex" && x.model === "FAKE-model"),
  );
  const saved = await x.request(
    "/api/live/analysis?key=" + audited.result.cacheKey,
  );
  assert.deepEqual(saved.result.semanticAudit, audited.result.semanticAudit);
  const y = await setup(t, (runner) => async (r) => {
    if (r.stage === "audit") throw Error("FAKE audit failure");
    return runner(r);
  });
  const failed = await y.run({ audit: true, auditConsent: true });
  assert.equal(failed.status, "succeeded", failed.error);
  assert.equal(failed.result.semanticAudit.status, "failed");
  assert.equal(failed.result.output.analysisStatus, "partial");
});

test("invalid synthesis references fail API job; insufficient context persists; partial chunks not disguised; cancellation blocks final persistence", async (t) => {
  const bad = await setup(t, (runner) => async (r) => {
    const out = await runner(r);
    if (r.stage === "synthesis")
      (out.output as any).overview.oneLiner.evidenceIds = [
        "https://untrusted.invalid/source",
      ];
    return out;
  });
  const rejected = await bad.run();
  assert.equal(rejected.status, "failed");
  assert.match(rejected.error, /synthesis_failed/);
  assert.equal(bad.api.store.list("analysis").length, 0);
  const partial = await setup(t, (runner) => {
    let fail = true;
    return async (r) => {
      if (fail && r.stage === "chunk") {
        fail = false;
        throw Error("FAKE chunk failure");
      }
      return runner(r);
    };
  });
  const p = await partial.run();
  assert.equal(p.processStatus, "succeeded", p.error);
  assert.equal(p.analysisStatus, "partial");
  assert.equal(p.result.coverage.failedChunks, 1);
  const insufficient = await setup(t, (runner) => async (r) => {
    const out = await runner(r);
    if (r.stage === "synthesis") {
      (out.output as any).analysisStatus = "insufficient_context";
      (out.output as any).limitations = [unknown("FAKE shortage")];
    }
    return out;
  });
  const limited = await insufficient.run();
  assert.equal(limited.status, "succeeded", limited.error);
  assert.equal(limited.analysisStatus, "insufficient_context");
  assert.equal(
    (await insufficient.run()).result.output.analysisStatus,
    "insufficient_context",
  );
  const cancel = await setup(t, () => async () => new Promise(() => {}));
  const job = await cancel.request("/api/live/run", "POST", cancel.payload);
  await new Promise((r) => setTimeout(r, 5));
  await cancel.request("/api/live/cancel", "POST", { id: job.id });
  for (let i = 0; i < 100 && ["running", "queued"].includes(job.status); i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(job.processStatus, "cancelled");
  assert.equal(cancel.api.store.list("analysis").length, 0);
});
