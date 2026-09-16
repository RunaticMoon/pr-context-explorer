import { test, expect } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/http";
import { LocalStore, cacheKey } from "../../src/server/store";
import { richSnapshot, richRunner } from "../integration-v3-fixture";
import { fakeEngineSetup } from "../fake-engine-setup";

test("Claude setup token password form clears secrets, never persists, and forget/error disable readiness", async ({
  page,
}) => {
  const cleanup: (() => void)[] = [];
  const snapshot = await richSnapshot({
    after: (f: () => void) => cleanup.push(f),
  });
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "claude-setup-browser-")),
  );
  const store = new LocalStore(root);
  store.put("config", cacheKey({ connection: snapshot.connectionId }), {
    id: snapshot.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "FAKE",
    auth: { kind: "public" },
  });
  store.put("snapshot", snapshot.snapshotId, { snapshot, stale: false });
  const setup = fakeEngineSetup();
  const status = await setup.status();
  const claude = status.engines[1];
  claude.localAuth = "unsupported";
  claude.ready = false;
  claude.authentication.status = "not_configured";
  const secret = "sk-ant-oat01-FAKE-browser-not-a-credential";
  let submitted = 0;
  setup.setSessionAuth = async (_provider, candidateId, token) => {
    expect(candidateId).toBe(claude.candidateId);
    expect(token).toBe(secret);
    submitted++;
    if (submitted > 2) throw Error(secret);
    claude.localAuth = "session";
    claude.ready = true;
    claude.authentication.status = "authenticated";
    return status;
  };
  setup.forgetSessionAuth = async () => {
    claude.localAuth = "unsupported";
    claude.ready = false;
    claude.authentication.status = "not_configured";
    return status;
  };
  const app = await createApp(0, { dataDir: root, engineSetup: setup });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  try {
    await page.goto(
      `http://127.0.0.1:${(app.address() as any).port}/?` +
        new URLSearchParams({
          page: "live-workspace",
          snapshot: snapshot.snapshotId,
          commit: snapshot.headSha,
        }),
    );
    await page
      .locator("summary")
      .filter({ hasText: "모델 선택 / 전송 동의 / 분석 실행" })
      .click();
    const panel = page.getByRole("region", { name: "로컬 AI 엔진 설정" });
    const input = panel.getByLabel("Claude setup token");
    await panel
      .getByRole("radio", { name: "Claude Code", exact: true })
      .check();
    await page.getByLabel("모델 식별자").fill("FAKE-no-inference");
    await page
      .getByLabel(
        "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
      )
      .check();
    const run = page.getByRole("button", {
      name: "PR 맥락 분석 실행",
      exact: true,
    });
    await expect(run).toBeDisabled();
    await expect(input).toHaveAttribute("type", "password");
    await expect(panel).toContainText("claude setup-token");
    await input.fill(secret);
    await panel.getByRole("button", { name: "이번 세션에 토큰 사용" }).click();
    await expect(input).toHaveValue("");
    await expect(run).toBeEnabled();
    await expect(panel).toContainText("앱 종료 시 삭제");
    expect(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
    ).not.toContain(secret);
    expect(await page.content()).not.toContain(secret);
    await panel.getByRole("button", { name: "세션 토큰 삭제" }).click();
    await expect(
      panel.getByRole("button", { name: "세션 토큰 삭제" }),
    ).toHaveCount(0);
    await expect(run).toBeDisabled();
    await input.fill(secret);
    await panel.getByRole("button", { name: "이번 세션에 토큰 사용" }).click();
    await expect(run).toBeEnabled();
    await input.fill(secret);
    await panel.getByRole("button", { name: "이번 세션에 토큰 사용" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(run).toBeDisabled();
    expect(await page.content()).not.toContain(secret);
    expect(submitted).toBe(3);
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    rmSync(root, { recursive: true, force: true });
    cleanup.forEach((f) => f());
  }
});

test("FAKE setup through real HTTP: discovery, explicit reuse, rescan, fail-closed UI; navigation never runs inference", async ({
  page,
}) => {
  const cleanup: (() => void)[] = [];
  const s = await richSnapshot({ after: (f: () => void) => cleanup.push(f) });
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "setup-browser-")));
  const store = new LocalStore(root),
    calls: any[] = [];
  store.put("config", cacheKey({ connection: s.connectionId }), {
    id: s.connectionId,
    type: "github",
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
    apiVersion: "2022-11-28",
    account: "FAKE",
    auth: { kind: "public" },
  });
  store.put("snapshot", s.snapshotId, { snapshot: s, stale: false });
  const setup = fakeEngineSetup();
  const status = await setup.status();
  status.engines[0].ready = false;
  status.engines[0].localAuth = "available";
  status.engines[0].authentication.status = "not_configured";
  let reuse = 0,
    rescans = 0;
  setup.reuseLocalAuth = async () => {
    reuse++;
    status.engines[0].ready = true;
    status.engines[0].localAuth = "reused";
    status.engines[0].authentication.status = "authenticated";
    return structuredClone(status);
  };
  setup.rescan = async () => {
    rescans++;
    throw Error("FAKE probe unavailable");
  };
  const app = await createApp(0, {
    dataDir: root,
    engineSetup: setup,
    runner: richRunner(s, calls),
  });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(app.address() as any).port}`;
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
    const panel = page.getByRole("region", { name: "로컬 AI 엔진 설정" });
    await expect(panel).toContainText("FAKE-setup-not-inference");
    await page.getByLabel("모델 식별자").fill("FAKE-not-inference");
    await page
      .getByLabel(
        "선택 범위의 PR/코드/Jira를 선택 모델 제공자에게 전송하는 데 동의합니다.",
      )
      .check();
    const run = page.getByRole("button", {
      name: "PR 맥락 분석 실행",
      exact: true,
    });
    await expect(run).toBeDisabled();
    await panel
      .getByRole("button", { name: "기존 Codex 로그인 재사용에 동의" })
      .click();
    await expect(run).toBeEnabled();
    expect(reuse).toBe(1);
    expect(calls).toHaveLength(0);
    await expect(panel).toContainText(
      "실제 모델 호출은 아직 검증하지 않았습니다",
    );
    await panel.getByRole("button", { name: "다시 검색" }).click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(panel).not.toContainText("분석 준비됨");
    await expect(run).toBeDisabled();
    expect(rescans).toBe(1);
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    expect(calls).toHaveLength(0);
    expect(
      await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
    ).not.toContain("FAKE-candidate");
  } finally {
    await new Promise<void>((r) => app.close(() => r()));
    rmSync(root, { recursive: true, force: true });
    cleanup.forEach((f) => f());
  }
});
