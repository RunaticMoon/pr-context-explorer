import { test, expect } from "@playwright/test";
import { fakeEngineSetup } from "../fake-engine-setup";
import { collect } from "../../src/server/git";
import { MockProvider } from "../../src/server/provider";
test("intercepted real-Git fixture exercises live workspace revision, tour, cache and no navigation reruns (not inference)", async ({
  page,
}) => {
  const d = collect(),
    mock = await new MockProvider().analyze(d);
  const s = {
    ...d,
    mode: "live",
    connectionId: "e2e",
    accountContextId: "fixture",
    repositoryId: d.pr.repository,
    prNumber: 1,
    sourceEvidence: [],
    jira: null,
    jiraStatus: "no_data",
    jiraSnapshotHashes: [],
    capturedAt: "2026-01-01T00:00:00Z",
    chosenComparisonBaseSha: d.baseSha,
    prMetadataHash: "fixture",
    pr: {
      ...d.pr,
      title: "INTERCEPTED REAL-GIT FIXTURE — NOT LIVE INFERENCE",
      url: "https://github.com/demo/input/pull/1",
    },
    coverage: {
      ...d.coverage,
      complete: false,
      commitsDiscovered: 3,
      commitsRetrieved: 3,
    },
    baseline: {
      ...d.baseline,
      parentComparisons: [],
      files: d.baseline.files.map((f) => ({
        ...f,
        retrieved: true,
        lineage: "path",
      })),
    },
    phases: d.phases.map((p) => ({
      ...p,
      parentComparisons: [],
      files: p.files.map((f) => ({ ...f, retrieved: true, lineage: "path" })),
    })),
  };
  const result = {
    output: {
      ...mock,
      schemaVersion: "2",
      steps: mock.steps.map((t) => ({ ...t, requirementIds: [] })),
      requirementMappings: [],
    },
    scope: { kind: "pr" },
    cacheKey: "d".repeat(64),
    metadata: {
      providerId: "codex",
      model: "fixture-model",
      verification: "INTERCEPTED OUTPUT, NOT INFERENCE",
    },
  };
  let runs = 0;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("**/api/engines/setup", async (r) =>
    r.fulfill({ json: await fakeEngineSetup().status() }),
  );
  await page.route("**/api/live/snapshot?*", (r) =>
    r.fulfill({ json: { snapshot: s, stale: false } }),
  );
  await page.route("**/api/live/analysis?*", (r) =>
    r.fulfill({ json: { result } }),
  );
  await page.route("**/api/live/run", (r) => {
    runs++;
    return r.fulfill({ json: { cached: true, result } });
  });
  await page.goto("/?page=live-workspace&snapshot=" + s.snapshotId);
  await expect(page.getByRole("heading", { name: s.pr.title })).toBeVisible();
  await expect(
    page.getByText("모의 설명으로 대체하지 않습니다.", { exact: false }),
  ).toBeVisible();
  await page
    .locator("button.file")
    .filter({ hasText: "src/process.ts" })
    .click();
  await expect(page.getByTestId("live-evidence-location")).toContainText(
    s.headSha,
  );
  await page
    .locator("summary")
    .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
    .click();
  await page
    .getByRole("button", { name: "분석 엔진 설정", exact: true })
    .click();
  await page.getByText("고급 모델 설정 (선택)", { exact: true }).click();
  await page.getByLabel("모델 식별자").fill("fixture-model");
  await page.getByRole("button", { name: "← 작업 공간으로 돌아가기" }).click();
  await page
    .locator("summary")
    .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
    .click();
  await page
    .getByLabel(
      "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
    )
    .check();
  await page
    .getByRole("button", { name: "PR 맥락 분석 실행", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Guided Flow", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Guided Flow", exact: true }).click();
  await expect(page.getByTestId("live-tour")).toBeVisible();
  await page.getByRole("button", { name: "다음 단계", exact: true }).click();
  const saved = page.url();
  expect(
    await page.evaluate(
      (id) => localStorage.getItem("live-resume:" + id),
      s.snapshotId,
    ),
  ).toBe(new URL(saved).search.slice(1));
  await page.reload();
  await expect(page.getByTestId("live-tour")).toBeVisible();
  expect(page.url()).toBe(saved);
  expect(runs).toBe(1);
  await page.getByRole("button", { name: /Phase 1/ }).click();
  await expect(page.getByTestId("live-phase-message")).toContainText(
    d.phases[0].subject,
  );
  await expect(page.getByTestId("live-tour")).toHaveCount(0);
  await page.goBack();
  await expect(page.getByTestId("live-tour")).toBeVisible();
  expect(runs).toBe(1);
  const u = new URL(page.url());
  u.searchParams.set("start", "99999");
  await page.goto(u.toString());
  await expect(page.getByRole("alert")).toContainText("선택 상태");
  expect(runs).toBe(1);
  expect(errors).toEqual([]);
});
