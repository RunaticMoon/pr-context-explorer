import test from "node:test";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
test(
  "real Electron window loads compiled app with sandbox, isolated read-only preload, external updater and graceful quit",
  { timeout: 60000 },
  async () => {
    const data = await realpath(
      await mkdtemp(path.join(tmpdir(), "prce-electron-")),
    );
    let app;
    try {
      app = await electron.launch({
        args: [path.resolve("desktop/build/app")],
        chromiumSandbox: true,
        env: { ...process.env, PRCE_DESKTOP_TEST_DATA: data },
        timeout: 30000,
      });
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(
        () => typeof window.prceDesktop?.status === "function",
      );
      const prefs = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0];
        return w.webContents.getLastWebPreferences();
      });
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
      // Extra arguments cannot be forwarded by preload; only status can be read.
      assert.equal(malicious, "limited");
      assert.equal((await fetch(page.url())).status, 403);
      const marker = JSON.parse(
        await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
      );
      assert.equal(marker.pid, app.process().pid);
      const closed = new Promise((resolve) => app.once("close", resolve));
      await app.evaluate(({ app }) => app.quit());
      await closed;
      await assert.rejects(readFile(path.join(data, "desktop-runtime.json")));
      assert.equal(Number.isSafeInteger(marker.backendPid), true);
      assert.throws(() => process.kill(marker.backendPid, 0));
    } finally {
      if (app) await app.close().catch(() => {});
      await rm(data, { recursive: true, force: true });
    }
  },
);
