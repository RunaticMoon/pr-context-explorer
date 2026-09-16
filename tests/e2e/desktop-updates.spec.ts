import { test, expect } from "@playwright/test";
// Explicit renderer-only FAKE bridge. No release, download, install or inference occurs.
test("update settings use only finite desktop capability (FAKE bridge fixture)", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() !== "GET" &&
      /\/api\/(engines\/setup|live\/run)/.test(r.url())
    )
      requests.push(r.url());
  });
  await page.addInitScript(() => {
    const w = window as any;
    w.updateCalls = [];
    const state = {
      version: "1.2.3",
      preferences: { autoCheck: true, autoDownload: false },
      publicUpdates: {
        enabled: true,
        channel: "public-personal",
        phase: "idle",
      },
    } as any;
    const call = (action: string, phase?: string) => {
      w.updateCalls.push(action);
      if (phase) state.publicUpdates.phase = phase;
      return Promise.resolve();
    };
    w.prceDesktop = {
      status: async () => structuredClone(state),
      checkUpdate: () => {
        state.publicUpdates.version = "1.3.0";
        return call("check", "available");
      },
      downloadUpdate: () => {
        state.publicUpdates.total = 2097152;
        state.publicUpdates.received = 2097152;
        return call("download", "downloaded");
      },
      cancelUpdate: () => call("cancel", "cancelled"),
      installUpdate: () => {
        state.publicUpdates.errorCode = "BUSY";
        return call("install");
      },
      updatePreferences: async (autoCheck: boolean, autoDownload: boolean) => {
        state.preferences = { autoCheck, autoDownload };
        await call("preferences");
      },
    };
  });
  await page.goto("/#page=live-connections&tab=updates");
  await page.getByRole("tab", { name: "업데이트", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "앱 업데이트", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("1.2.3", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "설치 및 재시작…" }),
  ).toBeDisabled();
  await page.getByLabel("새 버전 자동 다운로드", { exact: false }).check();
  await page.getByRole("button", { name: "지금 확인", exact: true }).click();
  await expect(page.getByText("1.3.0", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "다운로드", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("max", "2097152");
  await page.getByRole("button", { name: "설치 및 재시작…" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "분석은 취소되지 않았습니다",
  );
  expect(await page.evaluate(() => (window as any).updateCalls)).toEqual([
    "preferences",
    "check",
    "download",
    "install",
  ]);
  expect(requests).toEqual([]);
});
test("browser update tab cannot issue update or analysis requests", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (
      r.method() !== "GET" &&
      /\/api\/(engines\/setup|live\/run|updates)/.test(r.url())
    )
      requests.push(r.url());
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "업데이트", exact: true }).click();
  await expect(
    page.getByText("브라우저에서는 업데이트를 실행할 수 없습니다.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "지금 확인", exact: true }),
  ).toHaveCount(0);
  expect(requests).toEqual([]);
});
test("stale desktop status disables update actions (FAKE bridge fixture)", async ({
  page,
}) => {
  await page.addInitScript(() => {
    (window as any).prceDesktop = {
      status: async () => {
        throw Error("FAKE offline");
      },
    };
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "업데이트", exact: true }).click();
  await expect(page.locator(".update-panel").getByRole("status")).toContainText(
    "앱 상태를 읽을 수 없습니다",
  );
  await expect(
    page.getByRole("button", { name: "지금 확인", exact: true }),
  ).toBeDisabled();
});
