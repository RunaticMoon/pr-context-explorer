import { test, expect } from "@playwright/test";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { collect } from "../../src/server/git";
import { repo } from "../../src/server/fixture";
import {
  collectGit,
  compareGit,
  type LiveSnapshot,
} from "../../src/server/live-git";
import { fakeEngineSetup } from "../fake-engine-setup";

let snapshot: LiveSnapshot;
let fixtureRoot: string;
let bare: string;
test.beforeAll(async () => {
  const d = collect();
  fixtureRoot = mkdtempSync(path.join(tmpdir(), "prce-compare-browser-"));
  bare = path.join(fixtureRoot, "fixture.git");
  execFileSync("git", ["clone", "--bare", "--quiet", repo, bare]);
  snapshot = await collectGit({
    barePath: bare,
    baseSha: d.baseSha,
    headSha: d.headSha,
    identity: {
      connectionId: "comparison-fixture",
      accountContextId: "fixture",
      repository: d.pr.repository,
      number: 1,
    },
    pr: {
      title: "EXPLICIT REAL GIT FIXTURE · comparison navigation",
      body: "입력 검증과 처리 흐름을 단계별로 연결합니다. 테스트 fixture이며 실제 PR 분석이 아닙니다.",
      author: "Fixture",
      url: "https://github.com/demo/input/pull/1",
    },
  });
});

test.afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/engines/setup", async (r) =>
    r.fulfill({ json: await fakeEngineSetup().status() }),
  );
  await page.route("**/api/live/snapshot?*", (r) =>
    r.fulfill({ json: { snapshot, stale: false } }),
  );
});

test("intent-first entry, real commits, comparison selection, history and overview restore", async ({
  page,
}) => {
  await page.route("**/api/live/compare", async (r) => {
    const { fromSha, toSha } = r.request().postDataJSON();
    await r.fulfill({
      json: await compareGit(bare, fromSha, toSha),
    });
  });
  await page.goto("/?page=live-workspace&snapshot=" + snapshot.snapshotId);
  await expect(
    page.getByRole("heading", { name: "왜 필요한 PR인가" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "최종적으로 달라지는 것" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "처음부터 따라 읽기" }).click();
  await expect(page.getByTestId("comparison-location")).toContainText(
    snapshot.phases[0].sha.slice(0, 12),
  );
  await expect(
    page.getByRole("button", { name: "Guided Flow", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Phase 2", exact: true }).click();
  await page
    .getByRole("button", { name: "여기까지 누적", exact: true })
    .click();
  await expect(page.getByTestId("comparison-location")).toContainText(
    snapshot.chosenComparisonBaseSha!.slice(0, 12),
  );
  await expect(page.locator(".commit-file-reader")).toBeVisible();
  const selected = new URL(page.url()).searchParams.get("file");
  await page.getByRole("button", { name: "PR 전체 맥락으로 돌아가기" }).click();
  await expect(
    page.getByRole("heading", { name: "왜 필요한 PR인가" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "전체 맥락 접기" }).click();
  expect(new URL(page.url()).searchParams.get("file")).toBe(selected);
  await expect(page.getByTestId("comparison-location")).toContainText(
    "여기까지 누적",
  );
  await page.getByRole("button", { name: "최종 PR 변경", exact: true }).click();
  await expect(page.getByTestId("comparison-location")).toContainText(
    snapshot.headSha.slice(0, 12),
  );
  await expect(page.locator(".commit-file-reader")).toBeVisible();
});

test("a delayed comparison response cannot overwrite a newer selected phase", async ({
  page,
}) => {
  let releaseOld: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let oldStarted = false;
  await page.route("**/api/live/compare", async (r) => {
    const { fromSha, toSha } = r.request().postDataJSON();
    const comparison = await compareGit(bare, fromSha, toSha);
    if (toSha === snapshot.headSha) {
      oldStarted = true;
      await gate;
    }
    await r.fulfill({ json: comparison });
  });
  await page.goto(
    `/?page=live-workspace&snapshot=${snapshot.snapshotId}&commit=${snapshot.headSha}&mode=Code+Explorer`,
  );
  await page
    .getByRole("button", { name: "여기까지 누적", exact: true })
    .click();
  await expect.poll(() => oldStarted).toBe(true);
  await expect(
    page.getByText("선택한 비교 범위 읽는 중…", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Phase 2", exact: true }).click();
  await expect(page.locator(".commit-file-reader")).toBeVisible();
  const before = await page.locator(".commit-file-reader").innerText();
  releaseOld();
  await page.waitForTimeout(150);
  await expect(page.getByTestId("comparison-location")).toContainText(
    snapshot.phases[1].sha.slice(0, 12),
  );
  await expect(page.locator(".commit-file-reader")).toHaveText(before, {
    useInnerText: true,
  });
  expect(new URL(page.url()).searchParams.get("commit")).toBe(
    snapshot.phases[1].sha,
  );
});

test("failure from an abandoned snapshot cannot replace the active PR with an error", async ({
  page,
}) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false;
  await page.route(
    "**/api/live/snapshot?id=abandoned-snapshot",
    async (route) => {
      started = true;
      await gate;
      await route.fulfill({
        status: 404,
        json: { error: "abandoned snapshot failed" },
      });
    },
  );
  await page.goto(
    `/?page=live-workspace&snapshot=${snapshot.snapshotId}&commit=${snapshot.headSha}`,
  );
  await expect(
    page.getByRole("heading", { name: snapshot.pr.title }),
  ).toBeVisible();
  const selectSnapshot = async (id: string) =>
    page.evaluate((snapshotId) => {
      const url = new URL(location.href);
      url.searchParams.set("snapshot", snapshotId);
      history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, id);
  await selectSnapshot("abandoned-snapshot");
  await expect.poll(() => started).toBe(true);
  await selectSnapshot(snapshot.snapshotId);
  await expect(
    page.getByRole("heading", { name: snapshot.pr.title }),
  ).toBeVisible();
  release();
  await page.waitForTimeout(150);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: snapshot.pr.title }),
  ).toBeVisible();
});
