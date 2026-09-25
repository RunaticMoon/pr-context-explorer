import { fakeEngineSetup } from "../fake-engine-setup";
import { test, expect } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/http";
import { LocalStore, cacheKey } from "../../src/server/store";
import { richSnapshot, richRunner } from "../integration-v3-fixture";

test("provider change resets transmission/audit consent from both the workspace select and the settings engine radio (FAKE runner)", async ({
  page,
}) => {
  test.setTimeout(90000);
  const cleanup: (() => void)[] = [];
  const s = await richSnapshot({ after: (f) => cleanup.push(f) });
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-consent-reset-")),
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
  const port = 4401,
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
    const engineSelect = page.getByRole("combobox", { name: "분석 엔진" });
    const consent = page.getByLabel(
      "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
    );
    const audit = page.getByLabel(
      "선택한 동일 엔진·모델의 의미 감사 추가 전송/과금 최대 1회에 동의합니다",
    );
    const run = page.getByRole("button", {
      name: "PR 맥락 분석 실행",
      exact: true,
    });
    await page
      .getByLabel("분석 모델 ID (필수)", { exact: true })
      .fill("FAKE-consent-reset-not-inference");
    await consent.check();
    await audit.check();
    await expect(run).toBeEnabled();

    await engineSelect.selectOption("claude");
    await expect(consent).not.toBeChecked();
    await expect(audit).not.toBeChecked();
    await expect(run).toBeDisabled();

    await consent.check();
    await audit.check();
    await expect(run).toBeEnabled();
    await page
      .getByRole("button", { name: "분석 엔진 설정", exact: true })
      .click();
    const panel = page.getByRole("region", { name: "로컬 AI 엔진 설정" });
    await panel
      .getByRole("radio", { name: "Codex", exact: true })
      .check();
    await page
      .getByRole("button", { name: "← 작업 공간으로 돌아가기" })
      .click();
    await expect(consent).not.toBeChecked();
    await expect(audit).not.toBeChecked();
    await expect(run).toBeDisabled();

    expect(calls).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cleanup.forEach((f) => f());
    rmSync(root, { recursive: true, force: true });
  }
});
