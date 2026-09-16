import { fakeEngineSetup } from "../fake-engine-setup";
import { test, expect } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/http";
import { LocalStore, cacheKey } from "../../src/server/store";
import { richSnapshot, richRunner } from "../integration-v3-fixture";
import { objectFixture } from "../core-review-helpers";

test("V3 actual HTTP orchestrator: insufficient status, full grounding, head tour→Q&A→tour, cache/reload/back (FAKE runner, not inference)", async ({
  page,
}) => {
  test.setTimeout(90000);
  const cleanup: (() => void)[] = [];
  const s = await richSnapshot({ after: (f) => cleanup.push(f) });
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-v3-browser-")),
  );
  const store = new LocalStore(root),
    calls: any[] = [];
  const connection = {
    id: s.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "FAKE-fixture",
    auth: { kind: "public" },
  };
  store.put("config", cacheKey({ connection: s.connectionId }), connection);
  store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  const port = 4398,
    origin = `http://127.0.0.1:${port}`;
  const fakeRunner = richRunner(s, calls, "insufficient_context");
  const server = await createApp(port, {
    dataDir: root,
    engineSetup: fakeEngineSetup(),
    runner: (request) =>
      request.context.bundle.scope.kind === "code" &&
      request.context.bundle.scope.question === "FAKE cancel"
        ? new Promise(() => {})
        : fakeRunner(request),
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const errors: string[] = [],
    outside: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) outside.push(r.url());
  });
  try {
    await page.goto(
      origin +
        "/?" +
        new URLSearchParams({
          page: "live-workspace",
          snapshot: s.snapshotId,
          commit: s.headSha,
        }),
    );
    await page
      .locator("summary")
      .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
      .click();
    await page.getByLabel("모델 식별자").fill("FAKE-fixture-not-inference");
    await page
      .getByLabel(
        "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
      )
      .check();
    await page
      .getByRole("button", { name: "PR 맥락 분석 실행", exact: true })
      .click();
    await expect(page.getByTestId("live-analysis-status")).toContainText(
      "insufficient_context",
    );
    await expect(page.getByTestId("live-job")).toContainText("succeeded");
    await expect(page.getByTestId("live-missing-context")).toContainText(
      "FAKE 추가 사양",
    );
    await expect(page.getByTestId("live-missing-context")).toContainText(
      "FAKE 사용 목적",
    );
    await expect(
      page.getByText("FAKE 추정 연결 이유", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("live-discrepancies")).toContainText(
      "FAKE 원문과 코드 불일치",
    );
    await expect(page.getByTestId("live-pipeline-coverage")).toContainText(
      "분할",
    );
    const count = calls.length;
    expect(calls.filter((x) => x.stage === "chunk").length).toBeGreaterThan(1);
    await page
      .getByRole("button", { name: "Guided Flow", exact: true })
      .click();
    await expect(page.getByTestId("live-tour")).toContainText(s.headSha);
    expect(
      new URL(page.url()).searchParams.get("side"),
      "tour primary evidence must be new, before-side is secondary",
    ).toBe("new");
    await expect(page.getByTestId("live-story-edges")).toContainText(
      "FAKE 다음 읽기 이유",
    );
    const prKey = new URL(page.url()).searchParams.get("analysis");
    await page
      .getByRole("button", { name: "선택 범위 설명 실행", exact: true })
      .click();
    await expect(
      page.getByText("FAKE 선택 코드 답변", { exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("analysis")).toBe(prKey);
    const qaURL = page.url(),
      qaCalls = calls.length;
    expect(qaCalls).toBeGreaterThan(count);
    await page
      .getByRole("button", { name: "선택 범위 설명 실행", exact: true })
      .click();
    await expect(
      page.getByText("검증된 로컬 캐시 재사용", { exact: true }),
    ).toBeVisible();
    expect(calls.length).toBe(qaCalls);
    await page.reload();
    await expect(
      page.getByText("FAKE 선택 코드 답변", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Guided Flow", exact: true })
      .click();
    await expect(page.getByTestId("live-tour")).toContainText(
      "FAKE 고정 head 투어",
    );
    await page.goBack();
    expect(page.url()).toBe(qaURL);
    await expect(
      page.getByText("FAKE 선택 코드 답변", { exact: true }),
    ).toBeVisible();
    expect(calls.length).toBe(qaCalls);
    const clipped = await page
      .locator(".layout aside p, .layout aside h4, .layout aside button")
      .evaluateAll((els) =>
        els
          .filter((e) => e.scrollWidth > e.clientWidth + 1)
          .map((e) => e.textContent),
      );
    expect(
      clipped,
      "grounded IDs and Korean paragraphs must not be clipped",
    ).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "artifacts/integration-final-v3-qa.png",
      fullPage: true,
    });
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    const discrepancy = page.getByTestId("live-discrepancies");
    await discrepancy
      .getByRole("button")
      .filter({ hasText: "pr /" })
      .first()
      .click();
    await expect(page.getByTestId("live-source")).toBeVisible();
    await expect(page.getByTestId("live-source").locator("small")).toHaveCSS(
      "overflow-wrap",
      "anywhere",
    );
    await discrepancy
      .getByRole("button")
      .filter({ hasText: "(new)" })
      .first()
      .click();
    await expect(page.getByTestId("live-evidence-location")).toContainText(
      s.headSha,
    );
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "artifacts/integration-final-v3-evidence.png",
      fullPage: true,
    });
    await page
      .locator("summary")
      .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
      .click();
    await page.getByLabel("모델 식별자").fill("FAKE-fixture-not-inference");
    await page
      .getByLabel(
        "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
      )
      .check();
    await page
      .getByLabel(
        "선택한 동일 엔진·모델의 의미 감사 추가 전송/과금 최대 1회에 동의합니다 (선택)",
      )
      .check();
    await page
      .getByRole("button", { name: "PR 맥락 분석 실행", exact: true })
      .click();
    await expect(page.getByTestId("live-semantic-audit")).toContainText(
      "performed",
    );
    await expect(page.getByTestId("live-semantic-audit")).toContainText(
      "FAKE 감사 fixture",
    );
    expect(calls.filter((r) => r.stage === "audit").length).toBe(1);
    await page.reload();
    await expect(page.getByTestId("live-semantic-audit")).toContainText(
      "performed",
    );
    await page
      .locator("summary")
      .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
      .click();
    await page.getByLabel("모델 식별자").fill("FAKE-fixture-not-inference");
    await page
      .getByLabel(
        "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
      )
      .check();
    await page
      .getByRole("button", { name: "Guided Flow", exact: true })
      .click();
    const retained = new URL(page.url()).searchParams.get("analysis");
    await page.getByLabel("질문", { exact: true }).fill("FAKE cancel");
    await page
      .getByRole("button", { name: "선택 범위 설명 실행", exact: true })
      .click();
    await expect(page.getByTestId("live-job")).toContainText("running");
    await page
      .getByRole("button", { name: "현재 작업 취소", exact: true })
      .click();
    await expect(page.getByTestId("live-job")).toContainText("cancelled");
    await expect(page.getByTestId("live-tour")).toContainText(
      "FAKE 고정 head 투어",
    );
    expect(new URL(page.url()).searchParams.get("analysis")).toBe(retained);
    const expiredQA = new URL(page.url()).searchParams.get("codeAnalysis")!;
    store.delete("analysis", expiredQA);
    await page.reload();
    await expect(page.getByTestId("live-tour")).toContainText(
      "FAKE 고정 head 투어",
    );
    await expect(page.getByRole("alert")).toContainText(
      "analysis expired or missing",
    );
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup.forEach((f) => f());
    rmSync(root, { recursive: true, force: true });
  }
});

test("second-parent evidence navigation shows that exact old tree, never silently first parent", async ({
  page,
}) => {
  const cleanup: (() => void)[] = [],
    f = objectFixture({ after: (fn) => cleanup.push(fn) });
  const base = f.commit({ "a.ts": "export const n = 1;\n" });
  const left = f.commit({ "a.ts": "export const n = 2;\n" }, [base], "left");
  const right = f.commit({ "a.ts": "export const n = 3;\n" }, [base], "right");
  const head = f.commit(
    { "a.ts": "export const n = 4;\n" },
    [left, right],
    "merge",
  );
  const s = await f.collect(base, head);
  const file = s.phases
    .find((p) => p.sha === head)!
    .files.find((f) => f.path === "a.ts")!;
  const root = realpathSync(
      mkdtempSync(path.join(tmpdir(), "prce-v3-parent-browser-")),
    ),
    store = new LocalStore(root);
  store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  const origin = "http://127.0.0.1:4398",
    server = await createApp(4398, { dataDir: root });
  await new Promise<void>((r) => server.listen(4398, "127.0.0.1", r));
  try {
    await page.goto(
      origin +
        "/?" +
        new URLSearchParams({
          page: "live-workspace",
          snapshot: s.snapshotId,
          commit: head,
          comparison: right,
          file: file.id,
          side: "old",
          start: "1",
          end: "1",
          mode: "Code Explorer",
        }),
    );
    await expect(page.getByTestId("live-evidence-location")).toContainText(
      right,
    );
    await expect(page.getByTestId("live-code-old")).toContainText(
      "export const n = 3;",
    );
    await expect(page.getByTestId("live-code-old")).not.toContainText(
      "export const n = 2;",
    );
    await page.reload();
    await expect(page.getByTestId("live-code-old")).toContainText(
      "export const n = 3;",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup.forEach((f) => f());
    rmSync(root, { recursive: true, force: true });
  }
});
