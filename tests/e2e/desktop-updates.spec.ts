import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedUxFixtures } from "../../scripts/ux-fixture";
import { createApp } from "../../src/server/http";
import { fakeEngineSetup } from "../fake-engine-setup";

async function fakeUpdateBridge(page: Page, phase = "available") {
  await page.addInitScript((phase) => {
    const w = window as any;
    w.updateCalls = [];
    w.updateFixture = {
      version: "1.2.3",
      preferences: { autoCheck: true, autoDownload: false },
      publicUpdates: {
        enabled: true,
        channel: "public-personal",
        phase,
        version: "1.3.0",
      },
    };
    w.prceDesktop = {
      status: async () => {
        const snapshot = structuredClone(w.updateFixture);
        if (w.deferNextStatus) {
          w.deferNextStatus = false;
          return new Promise((resolve, reject) => {
            w.releaseOldStatus = () => resolve(snapshot);
            w.rejectOldStatus = () => reject(Error("FAKE old status failure"));
          });
        }
        return snapshot;
      },
      checkUpdate: async () => {
        w.updateCalls.push("check");
        w.updateFixture.publicUpdates.phase = "available";
      },
      downloadUpdate: async () => {
        w.updateCalls.push("download");
        w.updateFixture.publicUpdates.phase = "downloaded";
      },
      installUpdate: async () => {
        w.updateCalls.push("install");
      },
      updatePreferences: async (autoCheck: boolean, autoDownload: boolean) => {
        w.updateCalls.push("preferences");
        w.updateFixture.preferences = { autoCheck, autoDownload };
      },
      onOpenUpdates: (listener: () => void) => {
        w.openUpdatesFromMenu = listener;
        return () => {
          w.openUpdatesFromMenu = undefined;
        };
      },
    };
  }, phase);
}
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
  await expect(
    page.getByRole("button", { name: "지금 확인", exact: true }),
  ).toBeDisabled();
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

test("background availability is passive; dismissal survives settings and download readiness returns (FAKE bridge)", async ({
  page,
}, info) => {
  await fakeUpdateBridge(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/?page=live-list");
  const notice = page.getByRole("complementary", { name: "앱 업데이트 알림" });
  await expect(notice).toContainText("1.3.0");
  await notice.getByRole("button", { name: "나중에" }).click();
  await expect(notice).toHaveCount(0);
  await page.getByRole("button", { name: "앱 업데이트", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "앱 업데이트", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "내 PR / URL 열기" }).click();
  await expect(notice).toHaveCount(0);
  const entry = page.getByRole("button", { name: "앱 업데이트", exact: true });
  await entry.focus();
  await page.evaluate(() => {
    (window as any).updateFixture.publicUpdates.phase = "downloaded";
  });
  await expect(notice).toContainText("설치 준비 완료");
  await expect(entry).toBeFocused();
  expect(await page.evaluate(() => (window as any).updateCalls)).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("desktop-update-notice-1280.png"),
  });
  await notice.getByRole("button", { name: "설치 준비 확인" }).click();
  await expect(
    page.getByRole("button", { name: "설치 및 재시작…" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "지금 확인", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => (window as any).updateCalls)).toEqual([]);
});

test("native update entry preserves actual Git fixture phase, file and comparison on settings return", async ({
  page,
}) => {
  test.setTimeout(90000);
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-update-context-")),
  );
  const fixtures = await seedUxFixtures(root);
  const snapshot = fixtures.find(
    (fixture) => fixture.scenario === "small",
  )!.snapshot;
  const server = await createApp(0, {
    dataDir: root,
    engineSetup: fakeEngineSetup(),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing fixture port");
  try {
    await fakeUpdateBridge(page, "current");
    await page.goto(
      `http://127.0.0.1:${address.port}/?${new URLSearchParams({
        page: "live-workspace",
        snapshot: snapshot.snapshotId,
      })}`,
    );
    await page.getByRole("button", { name: "처음부터 따라 읽기" }).click();
    await page.getByRole("button", { name: "Phase 2", exact: true }).click();
    await page
      .getByRole("button", { name: "여기까지 누적", exact: true })
      .click();
    await expect(page.getByTestId("commit-file-reader")).toBeVisible();
    const before = new URL(page.url()).searchParams;
    expect(before.get("commit")).toBe(snapshot.phases[1].sha);
    expect(before.get("file")).toBeTruthy();
    await page.evaluate(() => (window as any).openUpdatesFromMenu());
    await expect(
      page.getByRole("heading", { name: "앱 업데이트", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "← 작업 공간으로 돌아가기" })
      .click();
    await expect(page.getByTestId("comparison-location")).toContainText(
      "여기까지 누적",
    );
    const after = new URL(page.url()).searchParams;
    for (const key of [
      "snapshot",
      "commit",
      "file",
      "scope",
      "comparison",
      "side",
      "mode",
    ])
      expect(after.get(key), key).toBe(before.get(key));
    await expect(page.getByTestId("commit-file-reader")).toBeVisible();
    expect(await page.evaluate(() => (window as any).updateCalls)).toEqual([]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent download preference and stale polls cannot overwrite an action (FAKE bridge)", async ({
  page,
}) => {
  await fakeUpdateBridge(page, "current");
  await page.goto("/?page=live-connections&tab=updates");
  const checks = page.getByLabel("시작 시 및 6시간마다 자동 확인");
  const downloads = page.getByLabel("새 버전 자동 다운로드", { exact: false });
  await checks.uncheck();
  await expect(downloads).toBeEnabled();
  await downloads.check();
  await expect(checks).not.toBeChecked();
  await expect(
    page.getByText(
      "자동 확인이 꺼져 있으면 직접 확인한 새 버전을 내려받습니다.",
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).deferNextStatus = true;
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).releaseOldStatus))
    .toBe("function");
  await page.getByRole("button", { name: "지금 확인", exact: true }).click();
  await expect(page.locator(".update-panel").getByRole("status")).toHaveText(
    "새 버전 있음",
  );
  await page.evaluate(() => (window as any).releaseOldStatus());
  await expect(page.locator(".update-panel").getByRole("status")).toHaveText(
    "새 버전 있음",
  );
  await page.evaluate(() => {
    const w = window as any;
    w.rejectOldStatus = undefined;
    w.deferNextStatus = true;
  });
  await expect
    .poll(() => page.evaluate(() => typeof (window as any).rejectOldStatus))
    .toBe("function");
  await page.getByRole("button", { name: "지금 확인", exact: true }).click();
  await page.evaluate(() => (window as any).rejectOldStatus());
  await expect(page.locator(".update-panel").getByRole("status")).toHaveText(
    "새 버전 있음",
  );
  await expect(
    page.getByRole("button", { name: "다운로드", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => (window as any).updateCalls)).toEqual([
    "preferences",
    "preferences",
    "check",
    "check",
  ]);
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
