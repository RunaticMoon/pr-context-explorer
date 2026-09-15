import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  sample,
  fixtureRunner,
  unknown,
  candidate,
  observed,
} from "./analysis-v3-fixtures.test.ts";
import { objectFixture } from "./core-review-helpers.ts";
const api = () => import("../src/server/analysis-v3/index.ts");
const hash = (x: string) => createHash("sha256").update(x).digest("hex");

async function withJira(s: any, criterion: string) {
  const { captureForSnapshot, discoverForSnapshot, editCandidates } =
    await import("../src/server/source-bridge.ts");
  const settings: any = {
    connections: [
      {
        id: "jira",
        deployment: "cloud",
        webBaseUrl: "https://tickets.example.invalid",
        apiBaseUrl: "https://tickets.example.invalid",
        accountContextId: "fixture",
        credential: {
          kind: "env",
          variable: "PRCE_JIRA_V3_FIXTURE",
          scheme: "Bearer",
        },
        acceptanceCriteriaFields: [{ id: "customfield_10001" }],
      },
    ],
    projectHosts: { TEAM: ["jira"] },
  };
  const d = editCandidates(discoverForSnapshot(s, settings), settings, {
    connectionId: "jira",
    key: "TEAM-12",
  });
  process.env.PRCE_JIRA_V3_FIXTURE = "fixture-not-a-real-credential";
  try {
    return await captureForSnapshot(s, settings, d, {
      dependencies: {
        transport: async () => ({
          status: 200,
          headers: { "content-type": "application/json" },
          body: (async function* () {
            yield Buffer.from(
              JSON.stringify({
                id: "42",
                key: "TEAM-12",
                fields: {
                  summary: "Original issue title",
                  description: {
                    type: "doc",
                    version: 1,
                    content: [
                      {
                        type: "paragraph",
                        content: [
                          {
                            type: "text",
                            text: "Original description, not explicit AC",
                          },
                        ],
                      },
                    ],
                  },
                  customfield_10001: criterion,
                  status: { name: "Open" },
                  issuetype: { name: "Story" },
                  updated: "2026-01-01T00:00:00Z",
                },
              }),
            );
          })(),
        }),
      },
    });
  } finally {
    delete process.env.PRCE_JIRA_V3_FIXTURE;
  }
}

test("actual normalized Jira AC roles and source hashes are transmitted without relabeling descriptions", async (t) => {
  const s = await withJira(await sample(t), "Reject blank input"),
    { planContext, mergeContexts, validateV3Output } = await api();
  const c = mergeContexts(
    s,
    { kind: "pr" },
    planContext(s, { kind: "pr" }).chunks.map((c) => c.context),
  );
  const ac = c.sources.find(
      (e) => e.fieldPath === "/fields/customfield_10001",
    )!,
    description = c.sources.find((e) => e.fieldPath === "/fields/description")!;
  assert.ok(ac, JSON.stringify(s.jiraData?.batch));
  assert.equal(c.sourceRoles[ac.id], "explicit_acceptance_criteria");
  assert.equal(c.sourceRoles[description.id], "source_text");
  const e = c.code.find(
      (x) => x.evidence.commitSha === s.headSha && x.evidence.side === "new",
    )!.evidence,
    value: any = candidate(s, e);
  value.requirements = [
    {
      id: "req",
      sourceRole: "explicit_acceptance_criteria",
      sourceEvidenceIds: [ac.id],
      statement: observed(ac.id),
    },
  ];
  assert.doesNotThrow(() => validateV3Output(value, s, c));
  value.requirements[0].sourceEvidenceIds = [description.id];
  value.requirements[0].statement = observed(description.id);
  assert.throws(() => validateV3Output(value, s, c), /acceptance/);
  assert.equal(ac.contentHash, hash(ac.text));
  assert.ok(s.jiraSnapshotHashes.includes(ac.version));
});

test("PR body, Jira capture, provider/model and prompt/schema/parser/planner changes invalidate actual pipeline cache", async (t) => {
  const raw = await sample(t),
    s = await withJira(raw, "Original explicit criterion"),
    { runPipeline } = await api(),
    calls: any[] = [],
    store = new Map<string, any>();
  const cache = {
    get: (k: string) => store.get(k),
    set: (k: string, v: any) => {
      store.set(k, v);
    },
  };
  const run = (snapshot = s, extra: any = {}) =>
    runPipeline({
      snapshot,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner: fixtureRunner(snapshot, calls),
      cache,
      ...extra,
    });
  await run();
  let count = calls.length;
  await run();
  assert.equal(calls.length, count);
  for (const dimension of [
    "prompt",
    "schema",
    "parser",
    "planner",
    "engineFingerprint",
  ]) {
    await run(s, { versions: { [dimension]: "changed" } });
    assert.ok(calls.length > count, dimension);
    count = calls.length;
  }
  const pr = structuredClone(s);
  pr.pr.body = "Original body changed by capture";
  pr.prMetadataHash = hash(pr.pr.body);
  for (const e of pr.sourceEvidence.filter((e) => e.sourceKind === "pr")) {
    e.version = pr.prMetadataHash;
    if (e.fieldPath === "/body") {
      e.text = pr.pr.body;
      e.contentHash = hash(e.text);
    }
  }
  await run(pr);
  assert.ok(calls.length > count);
  count = calls.length;
  const jira = await withJira(raw, "Changed explicit criterion");
  await run(jira);
  assert.ok(calls.length > count);
});

test("code-scope selection has exact parent/new ranges, no tour invocation, and cannot cite adjacent unsent lines", async (t) => {
  const f = objectFixture(t),
    base = f.commit({
      "core.ts": "export const a = 1;\nexport const b = 2;\n",
    }),
    head = f.commit(
      { "core.ts": "export const a = 3;\nexport const b = 4;\n" },
      [base],
    ),
    s = await f.collect(base, head),
    { runPipeline, planContext, mergeContexts, validateV3Output } = await api();
  const fileId = s.phases[0].files[0].id,
    scope = {
      kind: "code" as const,
      commitSha: head,
      fileId,
      side: "old" as const,
      lineStart: 2,
      lineEnd: 2,
      question: "이 범위의 역할은?",
    };
  const c = mergeContexts(
      s,
      scope,
      planContext(s, scope).chunks.map((c) => c.context),
    ),
    e = c.code[0].evidence;
  assert.equal(e.revisionSha, base);
  assert.equal(e.lineStart, 2);
  assert.equal(c.blobs[c.code[0].contentRef], "export const b = 2;");
  const calls: any[] = [],
    result = await runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope,
      runner: fixtureRunner(s, calls),
    });
  assert.ok(!calls.some((x) => x.stage === "tour"));
  assert.equal(result.selectionEvidence.length, 1);
  assert.equal(result.output.tour.steps.length, 0);
  const value: any = candidate(s, e);
  value.tour.steps = [];
  value.codeExplanations[0].roleInPR = observed(
    s.evidence.find(
      (x) => x.commitSha === head && x.side === "old" && x.lineStart === 1,
    )!.id,
  );
  assert.throws(() => validateV3Output(value, s, c), /transmitted/);
  assert.throws(() => planContext(s, { ...scope, lineEnd: 999 }), /range/);
});

test("large multi-commit PR has bounded chunks/synthesis and explicitly retains every excluded summary", async (t) => {
  const f = objectFixture(t),
    files = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `core${i}.ts`,
        Array.from(
          { length: 180 },
          (_, j) => `export const x${j} = ${j};`,
        ).join("\n"),
      ]),
    );
  const base = f.commit(files),
    head = f.commit(
      Object.fromEntries(
        Object.entries(files).map(([p, text]) => [
          p,
          text.replace("x1 = 1", "x1 = 2"),
        ]),
      ),
      [base],
    ),
    s = await f.collect(base, head),
    { runPipeline } = await api(),
    calls: any[] = [];
  const result = await runPipeline({
    snapshot: s,
    providerId: "codex",
    model: "chosen",
    scope: { kind: "pr" },
    runner: fixtureRunner(s, calls),
    budgets: { maxChunks: 12, maxChunkBytes: 10000, maxSynthesisBytes: 40000 },
  });
  assert.ok(calls.filter((x) => x.stage === "chunk").length > 1);
  assert.ok(
    calls.every(
      (x) =>
        Buffer.byteLength(JSON.stringify(x.context)) <=
        (x.stage === "chunk" ? 18000 : 40000),
    ),
  );
  assert.equal(result.output.analysisStatus, "partial");
  assert.ok(result.coverage.omitted.some((x) => x.reason === "chunk_limit"));
  assert.ok(
    result.coverage.omitted.some((x) => x.reason === "synthesis_byte_limit"),
  );
  assert.ok(result.output.missingContext.length);
  assert.ok(
    result.coverage.analyzedChunks > result.coverage.synthesizedChunkIds.length,
  );
});

test("unavailable evidence never triggers an inference call, while explicit insufficient_context remains process success", async (t) => {
  const s = await sample(t),
    { runPipeline } = await api();
  let called = 0;
  const empty = structuredClone(s);
  empty.evidence = [];
  empty.sourceEvidence = [];
  empty.coverage.complete = false;
  empty.coverage.unavailable = ["No retrievable evidence"];
  const absent = await runPipeline({
    snapshot: empty,
    providerId: "codex",
    model: "chosen",
    scope: { kind: "pr" },
    runner: async () => {
      called++;
      throw Error("must not run");
    },
  });
  assert.equal(called, 0);
  assert.equal(absent.output.analysisStatus, "insufficient_context");
  assert.equal(absent.processStatus, "succeeded");
  const base = fixtureRunner(s, []),
    result = await runPipeline({
      snapshot: s,
      providerId: "codex",
      model: "chosen",
      scope: { kind: "pr" },
      runner: async (r: any) => {
        const out = await base(r);
        if (r.stage === "synthesis") {
          out.output.analysisStatus = "insufficient_context";
          out.output.limitations = [unknown("자료 부족")];
        }
        return out;
      },
    });
  assert.equal(result.processStatus, "succeeded");
  assert.equal(result.output.analysisStatus, "insufficient_context");
});
