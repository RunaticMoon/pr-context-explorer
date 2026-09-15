import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { bounded, failureCleanup } from "../../desktop/smoke-helpers.mjs";

const data = process.argv[2];
const send = (message) => {
  if (process.connected) process.send(message);
};
let stage = "launch",
  app,
  successful = false;
const deadline = Date.now() + 55000;
const step = async (name, operation, maximum = 10000) => {
  stage = name;
  send({ type: "stage", stage });
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Error("overall deadline");
  return bounded(name, operation, Math.min(maximum, remaining));
};
try {
  app = await step(
    "launch",
    () =>
      electron.launch({
        args: [path.resolve("desktop/build/app"), `--user-data-dir=${data}`],
        chromiumSandbox: true,
        env: { ...process.env, PRCE_DESKTOP_TEST_DATA: data },
        timeout: 30000,
      }),
    32000,
  );
  send({ type: "electron-pid", pid: app.process().pid });
  const page = await step(
    "first-window",
    () => app.firstWindow({ timeout: 12000 }),
    13000,
  );
  await step("dom-content-loaded", () =>
    page.waitForLoadState("domcontentloaded"),
  );
  await step("preload-ready", () =>
    page.waitForFunction(
      () => typeof window.prceDesktop?.status === "function",
    ),
  );
  await step("security-and-status", async () => {
    const prefs = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    );
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    const status = await page.evaluate(() => window.prceDesktop.status());
    assert.equal(status.version, "0.4.0");
    assert.equal(status.updates.phase, "external");
    assert.deepEqual(
      await page.evaluate(() => Object.keys(window.prceDesktop)),
      ["status"],
    );
    assert.equal(await page.evaluate(() => typeof require), "undefined");
    assert.equal(await page.evaluate(() => typeof process), "undefined");
    assert.match(page.url(), /^http:\/\/127\.0\.0\.1:/);
    const malicious = await page.evaluate(async () => {
      try {
        await window.prceDesktop.status("bad");
        return "limited";
      } catch {
        return "denied";
      }
    });
    assert.equal(malicious, "limited");
  });
  await step(
    "unauthorized-http-denied",
    async () => {
      const response = await fetch(page.url(), {
        signal: AbortSignal.timeout(4000),
      });
      assert.equal(response.status, 403);
      await response.body?.cancel();
    },
    5000,
  );
  const marker = await step("runtime-marker", async () => {
    const marker = JSON.parse(
      await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
    );
    assert.equal(marker.pid, app.process().pid);
    assert.equal(Number.isSafeInteger(marker.backendPid), true);
    return marker;
  });
  const closed = new Promise((resolve) => app.once("close", resolve));
  const exited = new Promise((resolve) => {
    const child = app.process();
    if (child.exitCode !== null || child.signalCode !== null)
      resolve({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // Return the evaluate reply before requesting quit. Do not wait for a reply
  // from a destroyed main-process execution context. No dialog dismissal.
  await step("schedule-normal-quit", () =>
    app.evaluate(({ app }) => {
      setTimeout(() => app.quit(), 100);
      return true;
    }),
  );
  await step("normal-quit-close-event", () => closed, 12000);
  await step("normal-quit-process-exit", async () => {
    assert.deepEqual(await exited, { code: 0, signal: null });
  });
  await step("normal-quit-sidecar-cleanup", async () => {
    await assert.rejects(readFile(path.join(data, "desktop-runtime.json")), {
      code: "ENOENT",
    });
    assert.throws(() => process.kill(marker.backendPid, 0), { code: "ESRCH" });
  });
  successful = true;
  send({ type: "success" });
} catch {
  // Raw Playwright errors include launch commands, inspector URLs and page data.
  send({ type: "stage", stage: `failed-${stage}` });
  process.exitCode = 1;
} finally {
  if (!successful) await failureCleanup(app, () => {}, 3000);
  // If Playwright retained sockets, the outer supervisor still enforces the
  // total deadline and reaps only this driver and identity-verified app groups.
  if (process.connected) process.disconnect();
}
