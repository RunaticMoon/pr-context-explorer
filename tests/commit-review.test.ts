import { test } from "node:test";
import assert from "node:assert/strict";
import {
  phaseSummaryFor,
  commitFileChanges,
  comparisonPartial,
  stepsForRevision,
  changeGroupsForPhase,
  commitReview,
  engineBlockers,
  httpEngineBlockers,
  runBlockers,
  codeQuestionBlockers,
  MODEL_ID_PATTERN,
  type CommitPhase,
} from "../src/commit-review.ts";
import type { HttpEngineView } from "../src/ai-contract.ts";
import type { AIErrorCode } from "../src/server/ai/errors.ts";
import type {
  EngineSetupEntry,
  EngineSetupStatus,
} from "../src/server/engine-setup.ts";
import type {
  GroundedStatement,
  V3Output,
} from "../src/server/analysis-v3/types.ts";

function stmt(text: string): GroundedStatement {
  return {
    text,
    kind: "observed",
    evidenceIds: [],
    confidence: "high",
    rationale: "",
    limitation: "",
  };
}

function summary(commitSha: string, comparisonFromSha: string | null) {
  return {
    commitSha,
    comparisonFromSha,
    title: stmt(`summary-${commitSha}`),
    before: stmt(""),
    changes: stmt(""),
    why: stmt(""),
    limitationsOfPhase: stmt(""),
    focusFileIds: [],
    focusGraphEdgeIds: [],
    focusHunkIds: [],
  };
}

function group(
  id: string,
  commitShas: string[],
  fileIds: string[],
): V3Output["changeGroups"][number] {
  return {
    id,
    title: stmt(`group-${id}`),
    purpose: stmt(""),
    fileIds,
    commitShas,
    evidenceIds: [],
  };
}

function phase(overrides: Partial<CommitPhase> = {}): CommitPhase {
  return {
    sha: "c1",
    subject: "commit subject",
    comparisonFromSha: "p0",
    hunks: [],
    files: [],
    ...overrides,
  };
}

function file(
  overrides: Partial<CommitPhase["files"][number]> = {},
): CommitPhase["files"][number] {
  return {
    id: "f1",
    path: "src/a.ts",
    status: "modified",
    oldPath: null,
    ...overrides,
  };
}

function auth(
  status: EngineSetupEntry["authentication"]["status"],
): EngineSetupEntry["authentication"] {
  return {
    status,
    method: null,
    checkedBy: "not-checked",
    networkValidated: false,
  };
}

function engine(overrides: Partial<EngineSetupEntry> = {}): EngineSetupEntry {
  return {
    providerId: "codex",
    installed: true,
    cliVersion: "1.0.0",
    capabilities: { supported: true, version: "1.0.0", missing: [] },
    authentication: auth("authenticated"),
    isolation: {
      backend: "linux-bwrap",
      available: true,
      runtimeVerified: true,
      blocker: null,
    },
    blockers: [],
    ready: false,
    inferenceVerified: false,
    candidateId: null,
    localAuth: "missing",
    ...overrides,
  };
}

function status(...engines: EngineSetupEntry[]): EngineSetupStatus {
  return { engines };
}

function httpView(overrides: Partial<HttpEngineView> = {}): HttpEngineView {
  return {
    providerId: "openai-compatible",
    transport: "http",
    configId: "cfg-1",
    revision: 1,
    host: "api.example.com:8443",
    model: "gpt-4o-mini",
    hasApiKey: true,
    verification: "verified",
    blockers: [],
    ready: true,
    ...overrides,
  };
}

test("phaseSummaryFor matches only the exact (commitSha, comparisonFromSha) pair", () => {
  const target = summary("c1", "p0");
  const output = {
    phaseSummaries: [summary("c1", "other-parent"), target, summary("c2", "p0")],
  };
  assert.equal(
    phaseSummaryFor(output, { sha: "c1", comparisonFromSha: "p0" }),
    target,
  );
  assert.equal(
    phaseSummaryFor(output, { sha: "c1", comparisonFromSha: "other-parent" }),
    output.phaseSummaries[0],
  );
});

test("phaseSummaryFor matches a null comparisonFromSha for the root commit", () => {
  const root = summary("c0", null);
  const output = { phaseSummaries: [summary("c0", "p0"), root] };
  assert.equal(
    phaseSummaryFor(output, { sha: "c0", comparisonFromSha: null }),
    root,
  );
});

test("phaseSummaryFor selects each parent's summary on a merge commit", () => {
  const first = summary("m1", "p1");
  const second = summary("m1", "p2");
  const output = { phaseSummaries: [first, second] };
  const merge = phase({
    sha: "m1",
    comparisonFromSha: "p1",
    parentComparisons: [
      { fromSha: "p1", toSha: "m1", partial: false },
      { fromSha: "p2", toSha: "m1", partial: false },
    ],
  });
  // The selected comparison base, not the phase's first parent, picks the summary.
  for (const c of merge.parentComparisons!) {
    assert.equal(
      phaseSummaryFor(output, {
        sha: merge.sha,
        comparisonFromSha: c.fromSha,
      }),
      c.fromSha === "p1" ? first : second,
    );
  }
});

test("phaseSummaryFor returns undefined for absent pairs or missing output", () => {
  const output = { phaseSummaries: [summary("c1", "p0")] };
  assert.equal(
    phaseSummaryFor(output, { sha: "c1", comparisonFromSha: null }),
    undefined,
  );
  assert.equal(
    phaseSummaryFor(undefined, { sha: "c1", comparisonFromSha: "p0" }),
    undefined,
  );
});

test("commitFileChanges excludes unchanged files but keeps changed files with zero hunks", () => {
  const changes = commitFileChanges(
    phase({
      hunks: [],
      files: [
        file({ id: "keep", status: "modified" }),
        file({ id: "ctx", status: "unchanged" }),
      ],
    }),
  );
  assert.deepEqual(
    changes.map((c) => c.id),
    ["keep"],
  );
});

test("commitFileChanges marks deleted files as old side and renames as old → new", () => {
  const [del, ren, add] = commitFileChanges(
    phase({
      files: [
        file({ id: "del", status: "deleted", path: "src/gone.ts" }),
        file({
          id: "ren",
          status: "renamed",
          path: "src/new.ts",
          oldPath: "src/old.ts",
        }),
        file({ id: "add", status: "added", path: "src/new2.ts" }),
      ],
    }),
  );
  assert.equal(del.side, "old");
  assert.equal(del.pathLabel, "src/gone.ts");
  assert.equal(ren.side, "new");
  assert.equal(ren.pathLabel, "src/old.ts → src/new.ts");
  assert.equal(add.side, "new");
  assert.equal(add.pathLabel, "src/new2.ts");
});

test("commitFileChanges keeps retrieval and omission caveats in notes", () => {
  const [caveat, clean] = commitFileChanges(
    phase({
      files: [
        file({ id: "n", retrieved: false, omission: "binary" }),
        file({ id: "ok" }),
      ],
    }),
  );
  assert.deepEqual(caveat.notes, ["원문 미확보", "binary"]);
  assert.deepEqual(clean.notes, []);
});

test("comparisonPartial reflects only the (comparisonFromSha → sha) entry", () => {
  const p = phase({
    sha: "c1",
    comparisonFromSha: "p0",
    parentComparisons: [
      { fromSha: "other", toSha: "c1", partial: true },
      { fromSha: "p0", toSha: "c2", partial: true },
      { fromSha: "p0", toSha: "c1", partial: false },
    ],
  });
  assert.equal(comparisonPartial(p), false);
  const match = p.parentComparisons!.find(
    (c) => c.fromSha === "p0" && c.toSha === "c1",
  )!;
  match.partial = true;
  assert.equal(comparisonPartial(p), true);
});

test("comparisonPartial is false without parentComparisons or a matching entry", () => {
  assert.equal(comparisonPartial(phase({ parentComparisons: undefined })), false);
  assert.equal(
    comparisonPartial(
      phase({
        parentComparisons: [{ fromSha: "p0", toSha: "other", partial: true }],
      }),
    ),
    false,
  );
});

type Step = { id: string; revisionSha: string; title: string };

test("stepsForRevision pins steps to the matching revision only", () => {
  const steps: Step[] = [
    { id: "s1", revisionSha: "head", title: "one" },
    { id: "s2", revisionSha: "head", title: "two" },
    { id: "s3", revisionSha: "old", title: "three" },
  ];
  assert.deepEqual(
    stepsForRevision(steps, "head").map((s) => s.id),
    ["s1", "s2"],
  );
  assert.deepEqual(stepsForRevision(steps, "past"), []);
  assert.deepEqual(stepsForRevision(undefined, "head"), []);
});

test("commitReview keeps head-only tour steps with extra fields and counts read steps", () => {
  const steps: Step[] = [
    { id: "s1", revisionSha: "head", title: "t1" },
    { id: "s2", revisionSha: "head", title: "t2" },
    { id: "s3", revisionSha: "head", title: "t3" },
  ];
  const head = commitReview(phase({ sha: "head" }), {
    steps,
    readIds: ["s1", "s3", "unrelated"],
  });
  assert.equal(head.steps.length, 3);
  assert.equal(head.steps[0].title, "t1");
  assert.equal(head.readCount, 2);
  const past = commitReview(phase({ sha: "past" }), { steps, readIds: ["s1"] });
  assert.equal(past.steps.length, 0);
  assert.equal(past.readCount, 0);
});

test("commitReview reports hunks, comparison base, partial flag and matched summary", () => {
  const p = phase({
    sha: "c1",
    subject: "subj",
    comparisonFromSha: "p0",
    hunks: [{}, {}, {}],
    parentComparisons: [{ fromSha: "p0", toSha: "c1", partial: true }],
  });
  const r = commitReview(p, {
    output: { phaseSummaries: [summary("c1", "p0")], changeGroups: [] },
  });
  assert.equal(r.hunkCount, 3);
  assert.equal(r.subject, "subj");
  assert.equal(r.comparisonFromSha, "p0");
  assert.equal(r.comparisonPartial, true);
  assert.equal(r.summary?.commitSha, "c1");
});

test("changeGroupsForPhase keeps groups for this commit with phase-local fileIds", () => {
  const p = phase({
    sha: "c1",
    files: [file({ id: "f1" }), file({ id: "f2" })],
  });
  const output = {
    changeGroups: [
      group("g1", ["c1"], ["f1", "f9"]),
      group("g2", ["c1", "c2"], ["f2"]),
      group("g3", ["c2"], ["f1"]),
    ],
  };
  const groups = changeGroupsForPhase(output, p);
  assert.deepEqual(
    groups.map((g) => g.group.id),
    ["g1", "g2"],
  );
  assert.deepEqual(groups[0].fileIds, ["f1"]);
  assert.equal(groups[0].shared, false);
  assert.deepEqual(groups[1].fileIds, ["f2"]);
  assert.equal(groups[1].shared, true);
  assert.deepEqual(changeGroupsForPhase(undefined, p), []);
});

test("engineBlockers reports a single status-unknown blocker when status is missing", () => {
  const blockers = engineBlockers(undefined, "codex");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].code, "status-unknown");
  assert.match(blockers[0].text, /단정하지 않습니다/);
});

test("engineBlockers reports engine-missing when the provider is absent from scan", () => {
  const blockers = engineBlockers(
    status(engine({ providerId: "claude" })),
    "codex",
  );
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["engine-missing"],
  );
});

test("engineBlockers returns no blockers when the engine is ready", () => {
  assert.deepEqual(engineBlockers(status(engine({ ready: true })), "codex"), []);
});

test("engineBlockers reports only not-installed when the CLI is missing", () => {
  const blockers = engineBlockers(
    status(engine({ installed: false })),
    "codex",
  );
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["not-installed"],
  );
});

test("engineBlockers lists missing capabilities for unsupported versions", () => {
  const blockers = engineBlockers(
    status(
      engine({
        capabilities: {
          supported: false,
          version: "0.0.1",
          missing: ["--json", "reviewed-version"],
        },
      }),
    ),
    "codex",
  );
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["unsupported-version"],
  );
  assert.match(blockers[0].text, /--json/);
  assert.match(blockers[0].text, /reviewed-version/);
});

test("engineBlockers reports isolation failures with the blocker detail", () => {
  const blockers = engineBlockers(
    status(
      engine({
        isolation: {
          backend: "unsupported",
          available: false,
          runtimeVerified: false,
          blocker: "no bwrap",
        },
      }),
    ),
    "codex",
  );
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["isolation"],
  );
  assert.match(blockers[0].text, /no bwrap/);
});

test("engineBlockers specializes not_configured auth via localAuth", () => {
  const cases: [EngineSetupEntry["localAuth"], string][] = [
    ["available", "auth-reuse-consent"],
    ["missing", "auth-file-missing"],
    ["unsupported", "auth-manual"],
  ];
  for (const [localAuth, code] of cases) {
    const blockers = engineBlockers(
      status(engine({ authentication: auth("not_configured"), localAuth })),
      "codex",
    );
    assert.deepEqual(
      blockers.map((b) => b.code),
      [code],
    );
  }
  const generic = engineBlockers(
    status(engine({ authentication: auth("not_configured"), localAuth: "reused" })),
    "codex",
  );
  assert.deepEqual(
    generic.map((b) => b.code),
    ["auth-not_configured"],
  );
});

test("engineBlockers adds no auth blocker when authenticated", () => {
  for (const localAuth of [
    "available",
    "missing",
    "unsupported",
  ] as EngineSetupEntry["localAuth"][]) {
    const blockers = engineBlockers(
      status(
        engine({
          localAuth,
          isolation: {
            backend: "unsupported",
            available: false,
            runtimeVerified: false,
            blocker: "x",
          },
        }),
      ),
      "codex",
    );
    assert.deepEqual(
      blockers.map((b) => b.code),
      ["isolation"],
    );
  }
});

test("engineBlockers reports not_authenticated and unknown without asserting failure", () => {
  const notAuth = engineBlockers(
    status(engine({ authentication: auth("not_authenticated") })),
    "codex",
  );
  assert.deepEqual(
    notAuth.map((b) => b.code),
    ["auth-not_authenticated"],
  );
  const unknown = engineBlockers(
    status(engine({ authentication: auth("unknown") })),
    "codex",
  );
  assert.deepEqual(
    unknown.map((b) => b.code),
    ["auth-unknown"],
  );
  assert.match(unknown[0].text, /단정하지 않습니다/);
});

test("engineBlockers returns every applicable blocker at once", () => {
  const blockers = engineBlockers(
    status(
      engine({
        capabilities: {
          supported: false,
          version: "0.0.1",
          missing: ["--json"],
        },
        isolation: {
          backend: "unsupported",
          available: false,
          runtimeVerified: false,
          blocker: null,
        },
        authentication: auth("not_configured"),
        localAuth: "missing",
      }),
    ),
    "codex",
  );
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["unsupported-version", "isolation", "auth-file-missing"],
  );
});

test("engineBlockers falls back to a generic blocker for unlisted unready reasons", () => {
  const blockers = engineBlockers(status(engine({ ready: false })), "codex");
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["other"],
  );
});

test("runBlockers lists each disabled reason and stays empty when runnable", () => {
  const base = { busy: false, model: "gpt-5", consent: true, engineReady: true };
  assert.deepEqual(runBlockers(base), []);
  assert.deepEqual(runBlockers({ ...base, busy: true }), [
    "다른 작업이 진행 중입니다",
  ]);
  assert.deepEqual(runBlockers({ ...base, model: "  " }), [
    "모델 ID를 입력하세요 (필수)",
  ]);
  assert.deepEqual(runBlockers({ ...base, consent: false }), [
    "제공자 전송 동의가 필요합니다",
  ]);
  assert.deepEqual(runBlockers({ ...base, engineReady: false }), [
    "선택한 엔진이 아직 준비되지 않았습니다",
  ]);
  assert.equal(
    runBlockers({ busy: true, model: "", consent: false, engineReady: false })
      .length,
    4,
  );
});

test("runBlockers enforces the same model id rule as the server", () => {
  assert.equal(MODEL_ID_PATTERN.source, "^[-a-zA-Z0-9_.:/]{1,120}$");
  const base = {
    busy: false,
    model: "gpt-5",
    consent: true,
    engineReady: true,
  };
  const format =
    "모델 ID 형식이 올바르지 않습니다 (영문·숫자·-_.:/ 1–120자, 공백 불가)";
  for (const bad of [
    " gpt-5",
    "gpt 5",
    "gpt-5 ",
    "한글모델",
    "gpt;5",
    "gpt=5",
    "x".repeat(121),
  ])
    assert.deepEqual(runBlockers({ ...base, model: bad }), [format], bad);
  for (const ok of [
    "gpt-5",
    "claude-opus-4.1",
    "provider/model:v1",
    "a_b:c/d.e-f",
    "x".repeat(120),
  ])
    assert.deepEqual(runBlockers({ ...base, model: ok }), [], ok);
  // Blank stays on the required message, not the format message.
  assert.deepEqual(runBlockers({ ...base, model: " " }), [
    "모델 ID를 입력하세요 (필수)",
  ]);
});

test("codeQuestionBlockers appends selection reasons after run blockers", () => {
  const base = {
    runBlockers: [] as string[],
    fileSelected: true,
    rangeSelected: true,
    alternateComparison: false,
    hasContent: true,
  };
  assert.deepEqual(codeQuestionBlockers(base), []);
  assert.deepEqual(codeQuestionBlockers({ ...base, runBlockers: ["엔진 준비 안 됨"] }), [
    "엔진 준비 안 됨",
  ]);
  assert.deepEqual(codeQuestionBlockers({ ...base, fileSelected: false }), [
    "파일을 먼저 선택하세요",
  ]);
  assert.deepEqual(codeQuestionBlockers({ ...base, rangeSelected: false }), [
    "라인 범위를 선택하세요",
  ]);
  assert.deepEqual(codeQuestionBlockers({ ...base, alternateComparison: true }), [
    "추가 부모 비교 중 · 코드 Q&A는 첫 부모 비교만 지원합니다",
  ]);
  assert.deepEqual(codeQuestionBlockers({ ...base, hasContent: false }), [
    "선택 side에 내용이 없습니다",
  ]);
});

test("codeQuestionBlockers skips range and content checks when no file is selected", () => {
  const reasons = codeQuestionBlockers({
    runBlockers: [],
    fileSelected: false,
    rangeSelected: false,
    alternateComparison: false,
    hasContent: false,
  });
  assert.deepEqual(reasons, ["파일을 먼저 선택하세요"]);
});

test("httpEngineBlockers reports missing config, missing key and verification states", () => {
  assert.deepEqual(httpEngineBlockers(null), [
    "OpenAI 호환 API 설정이 필요합니다",
  ]);
  assert.deepEqual(httpEngineBlockers(undefined), [
    "OpenAI 호환 API 상태를 확인하는 중입니다",
  ]);
  assert.deepEqual(
    httpEngineBlockers(
      httpView({ hasApiKey: false, verification: "verified", ready: false }),
    ),
    ["API 키가 등록되지 않았습니다"],
  );
  assert.deepEqual(
    httpEngineBlockers(
      httpView({ verification: "not_checked", ready: false }),
    ),
    ["연결 확인이 필요합니다"],
  );
  assert.deepEqual(
    httpEngineBlockers(httpView({ verification: "checking", ready: false })),
    ["연결 확인 중입니다"],
  );
});

test("httpEngineBlockers accumulates applicable reasons for an unready engine", () => {
  assert.deepEqual(
    httpEngineBlockers(
      httpView({
        hasApiKey: false,
        verification: "not_checked",
        ready: false,
      }),
    ),
    ["API 키가 등록되지 않았습니다", "연결 확인이 필요합니다"],
  );
});

test("httpEngineBlockers appends known blocker descriptions after a failed check", () => {
  const reasons = httpEngineBlockers(
    httpView({
      verification: "failed",
      ready: false,
      blockers: ["auth_invalid", "rate_limited", "cli_missing"],
    }),
  );
  assert.deepEqual(reasons, [
    "연결 확인에 실패했습니다",
    "인증에 실패했거나 만료되었습니다.",
    "제공자 요청 속도 제한에 도달했습니다.",
  ]);
});

test("httpEngineBlockers skips codes without a known translation", () => {
  const reasons = httpEngineBlockers(
    httpView({
      verification: "failed",
      ready: false,
      blockers: ["future_code" as AIErrorCode],
    }),
  );
  assert.deepEqual(reasons, ["연결 확인에 실패했습니다"]);
});

test("httpEngineBlockers returns no blockers when the engine is ready", () => {
  assert.deepEqual(httpEngineBlockers(httpView()), []);
  assert.deepEqual(
    httpEngineBlockers(httpView({ blockers: ["auth_invalid"] })),
    [],
  );
});

test("httpEngineBlockers falls back to a generic reason when verified but unready", () => {
  assert.deepEqual(
    httpEngineBlockers(httpView({ ready: false })),
    ["준비 조건을 충족하지 못했습니다. 엔진 설정에서 상세를 확인하세요."],
  );
  assert.deepEqual(
    httpEngineBlockers(
      httpView({ ready: false, blockers: ["provider_unavailable"] }),
    ),
    ["제공자에 연결할 수 없습니다."],
  );
});

test("engineBlockers routes the HTTP provider to transport blockers, never CLI checks", () => {
  assert.deepEqual(
    engineBlockers(undefined, "openai-compatible", httpView()),
    [],
  );
  assert.deepEqual(
    engineBlockers(undefined, "openai-compatible", null).map((b) => b.code),
    ["http-config-missing"],
  );
  // A still-loading view gets its own blocker — never the missing-config one.
  assert.deepEqual(
    engineBlockers(undefined, "openai-compatible").map((b) => b.code),
    ["http-view-loading"],
  );
  assert.deepEqual(
    engineBlockers(undefined, "openai-compatible", undefined).map(
      (b) => b.text,
    ),
    ["OpenAI 호환 API 상태를 확인하는 중입니다"],
  );
  const blockers = engineBlockers(
    status(engine({ installed: false })),
    "openai-compatible",
    httpView({
      hasApiKey: false,
      verification: "failed",
      ready: false,
      blockers: ["auth_invalid"],
    }),
  );
  assert.deepEqual(
    blockers.map((b) => b.code),
    ["http-api-key-missing", "http-verify-failed", "http-auth_invalid"],
  );
});

test("runBlockers skips the model input requirement for the HTTP transport", () => {
  const base = {
    busy: false,
    model: "",
    consent: true,
    engineReady: true,
  };
  assert.deepEqual(runBlockers({ ...base, httpView: httpView() }), []);
  assert.deepEqual(runBlockers({ ...base, httpView: null }), []);
  assert.deepEqual(
    runBlockers({ ...base, httpView: httpView({ model: "bad model" }) }),
    [
      "저장된 엔진 설정의 모델 ID 형식이 올바르지 않습니다. 엔진 설정에서 수정하세요",
    ],
  );
});

test("runBlockers keeps busy, consent and engine checks for the HTTP transport", () => {
  const base = {
    busy: false,
    model: "",
    consent: true,
    engineReady: true,
    httpView: httpView(),
  };
  assert.deepEqual(runBlockers({ ...base, busy: true }), [
    "다른 작업이 진행 중입니다",
  ]);
  assert.deepEqual(runBlockers({ ...base, consent: false }), [
    "제공자 전송 동의가 필요합니다",
  ]);
  assert.deepEqual(runBlockers({ ...base, engineReady: false }), [
    "선택한 엔진이 아직 준비되지 않았습니다",
  ]);
});

test("codeQuestionBlockers carries HTTP run blockers through unchanged", () => {
  const httpReasons = runBlockers({
    busy: false,
    model: "",
    consent: true,
    engineReady: true,
    httpView: httpView({ model: "bad model" }),
  });
  assert.equal(httpReasons.length, 1);
  assert.deepEqual(
    codeQuestionBlockers({
      runBlockers: httpReasons,
      fileSelected: false,
      rangeSelected: false,
      alternateComparison: false,
      hasContent: false,
    }),
    [...httpReasons, "파일을 먼저 선택하세요"],
  );
});

test("codeQuestionBlockers keeps code questions disabled on the HTTP transport", () => {
  const base = {
    runBlockers: [] as string[],
    fileSelected: true,
    rangeSelected: true,
    alternateComparison: false,
    hasContent: true,
    httpTransport: true,
  };
  // Even a fully selected range stays disabled: the HTTP plan contract only
  // covers PR-scope analyses, so a code question could never send.
  assert.deepEqual(codeQuestionBlockers(base), [
    "OpenAI 호환 API에서는 PR 전체 분석만 지원합니다",
  ]);
  assert.deepEqual(codeQuestionBlockers({ ...base, fileSelected: false }), [
    "OpenAI 호환 API에서는 PR 전체 분석만 지원합니다",
    "파일을 먼저 선택하세요",
  ]);
});
