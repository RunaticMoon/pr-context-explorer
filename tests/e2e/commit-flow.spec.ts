import { fakeEngineSetup } from "../fake-engine-setup";
import { test, expect } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/http";
import { LocalStore, cacheKey } from "../../src/server/store";
import {
  richSnapshotThreeCommits,
  richRunner,
} from "../integration-v3-fixture";

test("commit timeline + review panel: per-commit navigation, head tour entry, no analysis reruns (FAKE runner)", async ({
  page,
}) => {
  test.setTimeout(90000);
  const cleanup: (() => void)[] = [];
  const s = await richSnapshotThreeCommits({ after: (f) => cleanup.push(f) });
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-commit-flow-")),
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
  const port = 4399,
    origin = `http://127.0.0.1:${port}`;
  const server = await createApp(port, {
    dataDir: root,
    engineSetup: fakeEngineSetup(),
    runner: richRunner(s, calls),
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const errors: string[] = [],
    outside: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => {
    if (!r.url().startsWith(origin)) outside.push(r.url());
  });
  const [first, second, head] = s.phases;
  const review = () => page.getByTestId("commit-review");
  const commitParam = () => new URL(page.url()).searchParams.get("commit");
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
    await expect(review()).toContainText("FAKE 3 테스트 보강");
    await expect(review()).toContainText(
      "분석 미실행 · Git 원문만 표시",
    );
    await page
      .getByRole("button", { name: "분석 엔진 설정", exact: true })
      .click();
    await page.getByText("고급 모델 설정 (선택)", { exact: true }).click();
    await page.getByLabel("모델 식별자").fill("FAKE-commit-flow-not-inference");
    await page
      .getByRole("button", { name: "← 작업 공간으로 돌아가기" })
      .click();
    await page
      .getByLabel(
        "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
      )
      .check();
    await page
      .getByRole("button", { name: "PR 맥락 분석 실행", exact: true })
      .click();
    await expect(page.getByTestId("live-analysis-status")).toContainText(
      "분석 complete",
    );
    await expect(page.getByTestId("live-job")).toContainText("succeeded");
    const count = calls.length;
    expect(count).toBeGreaterThan(0);

    await page
      .getByRole("button", { name: "Phase 1", exact: true })
      .click();
    await expect.poll(() => commitParam()).toBe(first.sha);
    await expect(review()).toContainText("FAKE 1 입력 규칙");
    await expect(review()).toContainText("변경 파일");
    await expect(review()).toContainText("변경 전");
    await expect(review()).toContainText("변경 내용");
    await expect(review()).toContainText("이유");
    await expect(review()).toContainText("여러 커밋에 걸친 묶음");
    await expect(review()).toContainText("이 revision의 투어 단계 없음");
    await expect(
      review().getByRole("button", { name: /고정 head 투어 열기/ }),
    ).toBeVisible();

    await page
      .getByRole("button", { name: "Phase 2", exact: true })
      .click();
    await expect.poll(() => commitParam()).toBe(second.sha);
    await expect(review()).toContainText("FAKE 2 처리 연결");
    await expect(review()).toContainText("변경 파일");
    await expect(review()).toContainText("이 revision의 투어 단계 없음");

    await page
      .getByRole("button", { name: "Phase 3", exact: true })
      .click();
    await expect.poll(() => commitParam()).toBe(head.sha);
    await expect(review()).toContainText("FAKE 3 테스트 보강");
    await expect(review()).toContainText("여러 커밋에 걸친 묶음");
    await expect(review()).toContainText("이 커밋의 투어 단계");
    await expect(review()).not.toContainText(
      "이 revision의 투어 단계 없음",
    );

    await page
      .getByRole("button", { name: "Phase 1", exact: true })
      .click();
    await review()
      .getByRole("button", { name: /고정 head 투어 열기/ })
      .click();
    await expect.poll(() => commitParam()).toBe(s.headSha);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("mode"))
      .toBe("Guided Flow");
    await expect(page.getByTestId("live-tour")).toContainText(s.headSha);

    expect(calls.length).toBe(count);
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup.forEach((f) => f());
    rmSync(root, { recursive: true, force: true });
  }
});
