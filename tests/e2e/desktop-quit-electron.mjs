// Focused quit-flow acceptance on the real compiled Electron app + real
// sidecar, with the Chromium sandbox ENABLED. The dialog is a labelled
// portable control (record-and-hold), not proof of native macOS sheet
// rendering; what is asserted is the REAL wiring: the confirmation must be
// attached to the visible window (macOS sheet => non-blocking main loop),
// repeated ordinary quit requests — including any signal Electron routes
// through app.quit()/before-quit — must deduplicate and keep waiting for the
// user's explicit answer, a declined answer returns the app to normal, and
// the bounded quit-stage breadcrumb names each stage.
//
// Sandbox policy: this suite never disables the sandbox — no
// ELECTRON_DISABLE_SANDBOX, no --no-sandbox, no chrome-sandbox permission
// changes. If the ambient environment carries ELECTRON_DISABLE_SANDBOX the
// suite refuses (skips) rather than inherit it. On hosts where the real
// sandbox cannot initialize (e.g. the SUID helper is not root-owned 4755 and
// no userns fallback), Electron aborts at startup; the probe below detects
// that and marks every test BLOCKED-skipped instead of claiming a green run.
// These tests remain runnable on a correctly configured host and on macOS.
import test from "node:test";
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const appPath = path.resolve("desktop/build/app");
const electronBinary = createRequire(import.meta.url)("electron");

// Explicit refusal: a sandbox-disabled ambient env is never stripped-and-run
// silently — it marks this suite non-acceptance and skips it.
const skipReason = process.env.ELECTRON_DISABLE_SANDBOX
  ? "BLOCKED: ELECTRON_DISABLE_SANDBOX present — sandbox-disabled runs are not acceptance evidence"
  : (() => {
      const probe = spawnSync(electronBinary, ["--version"], {
        encoding: "utf8",
        timeout: 15000,
      });
      if (probe.status === 0) return null;
      const detail = (
        probe.stderr ||
        probe.error?.message ||
        `exit ${probe.status}`
      )
        .split("\n")[0]
        .slice(0, 160);
      return `BLOCKED: real Electron cannot start with the sandbox enabled on this host (${detail})`;
    })();

async function launch() {
  const data = await mkdtemp(path.join(tmpdir(), "prce-quit-e2e-"));
  // Defense in depth: the child env can never carry a sandbox disable even
  // if the ambient environment was mutated after the probe.
  const env = { ...process.env, PRCE_DESKTOP_TEST_DATA: data };
  delete env.ELECTRON_DISABLE_SANDBOX;
  const app = await electron.launch({
    args: [appPath, `--user-data-dir=${data}`],
    chromiumSandbox: true,
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow({ timeout: 15000 });
  await page.waitForLoadState("domcontentloaded");
  // Labelled mock control: record every confirmation and hold it pending
  // until the test explicitly resolves consent.
  await app.evaluate(({ dialog }) => {
    globalThis.__rec = { calls: [], resolvers: [] };
    dialog.showMessageBox = (...args) => {
      const options = args[args.length - 1];
      globalThis.__rec.calls.push({
        message: options.message,
        attached: args.length > 1,
      });
      return new Promise((r) => globalThis.__rec.resolvers.push(r));
    };
  });
  return { app, page, data };
}

// Fire real engine-setup rescans until a concurrent request is rejected with
// 409 — proof a scan is in flight and the backend is busy right now — then
// keep rescanning so the quit -> before-quit -> status() IPC lands inside the
// busy window. Renderer window.close() is NOT used: it bypasses the
// preventable "close" event and destroys the window (Electron semantics), so
// the quit is issued via app.quit() from the driver instead.
async function startBusy(page) {
  return page.evaluate(async () => {
    const s = await fetch("/api/session", { method: "POST" });
    const { csrf } = await s.json();
    const scan = () =>
      fetch("/api/engines/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PRCE-CSRF": csrf,
        },
        body: '{"action":"rescan"}',
      });
    globalThis.__busy = true;
    void scan();
    let confirmed = false;
    for (let i = 0; i < 4000 && !confirmed; i++) {
      try {
        confirmed = (await scan()).status === 409;
      } catch {}
      if (!confirmed) await new Promise((r) => setTimeout(r, 2));
    }
    // Keep the pipeline hot so busy outlasts the quit->status latency.
    (async () => {
      while (globalThis.__busy) {
        try {
          await scan();
        } catch {
          await new Promise((r) => setTimeout(r, 10));
        }
      }
    })();
    return confirmed ? "busy" : "never-busy";
  });
}

async function stageOf(data) {
  try {
    return JSON.parse(
      await readFile(path.join(data, "desktop-quit-stage.json"), "utf8"),
    ).stage;
  } catch {
    return null;
  }
}

const alive = (app) => {
  const child = app.process();
  return child.exitCode === null && child.signalCode === null;
};

async function cleanup(app, data) {
  // A pending confirmation holds the app live by design: bound the graceful
  // close, then reap only this test's own process group.
  await Promise.race([app.close().catch(() => {}), pause(5000).then(() => {})]);
  try {
    process.kill(-app.process().pid, "SIGKILL");
  } catch {}
  await rm(data, { recursive: true, force: true });
}

// Whether a quit lands in a busy window is timing-dependent, so retry the
// whole launch a bounded number of times until the confirmation actually
// pends (stage file reaches confirm-open with the process still alive). If it
// never pends the caller asserts — retries can never turn missing busy-path
// coverage into a pass.
async function launchWedgedOnConfirm(attempts = 8) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const launched = await launch();
    const { app, page, data } = launched;
    let exited = false;
    app.once("close", () => (exited = true));
    try {
      if ((await startBusy(page)) !== "busy") {
        await cleanup(app, data);
        continue;
      }
      await app.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 0);
        return true;
      });
      for (let i = 0; i < 50 && !exited; i++) {
        if ((await stageOf(data)) === "confirm-open") return launched;
        await pause(100);
      }
    } catch {
      /* window may close if the quit took the idle path */
    }
    await cleanup(app, data);
  }
  return null;
}

// After a confirmed exit: the stage breadcrumb ends at quit-dispatch, the
// runtime marker is released, and the owned backend pid is reaped.
async function assertCleanExit(data, marker) {
  assert.equal(await stageOf(data), "quit-dispatch");
  await assert.rejects(readFile(path.join(data, "desktop-runtime.json")), {
    code: "ENOENT",
  });
  assert.throws(() => process.kill(marker.backendPid, 0), {
    code: "ESRCH",
  });
}

test(
  "busy quit attaches the confirmation to the window; consent exits cleanly",
  { timeout: 240000, skip: skipReason || false },
  async () => {
    const wedged = await launchWedgedOnConfirm();
    assert.ok(wedged, "could not land the quit inside a busy window");
    const { app, data } = wedged;
    try {
      const marker = JSON.parse(
        await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
      );
      const calls = await app.evaluate(() => globalThis.__rec.calls);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].message, "Cancel active work and quit?");
      assert.equal(
        calls[0].attached,
        true,
        "confirmation must attach to the visible window (macOS sheet)",
      );
      assert.equal(await stageOf(data), "confirm-open");
      await app.evaluate(() => {
        globalThis.__busy = false;
        globalThis.__rec.resolvers.forEach((r) => r({ response: 1 }));
        return true;
      });
      let exited = false;
      app.once("close", () => (exited = true));
      for (let i = 0; i < 80 && !exited; i++) await pause(100);
      assert.equal(exited, true, "consent must complete the quit");
      await assertCleanExit(data, marker);
    } finally {
      await cleanup(app, data);
    }
  },
);

test(
  "repeated quits and a routed SIGTERM during a pending confirmation cannot bypass consent",
  { timeout: 240000, skip: skipReason || false },
  async () => {
    const wedged = await launchWedgedOnConfirm();
    assert.ok(wedged, "could not land the quit inside a busy window");
    const { app, data } = wedged;
    try {
      const marker = JSON.parse(
        await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
      );
      const exited = new Promise((resolve) => {
        const child = app.process();
        if (child.exitCode !== null || child.signalCode !== null)
          resolve({ code: child.exitCode, signal: child.signalCode });
        else child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      assert.equal(await stageOf(data), "confirm-open");
      // A duplicate ordinary quit (double Cmd-Q / repeated Electron
      // before-quit) is neither consent nor proof of a signal: the app must
      // stay live, still pending the SAME confirmation.
      await app.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 0);
        return true;
      });
      await pause(2000);
      assert.equal(alive(app), true, "duplicate quit must not exit");
      assert.equal(await stageOf(data), "confirm-open");
      assert.equal(
        (await app.evaluate(() => globalThis.__rec.calls)).length,
        1,
        "no stacked confirmation",
      );
      // On Linux, Electron is observed to route SIGTERM through
      // app.quit()/before-quit — which deduplicates like any repeated quit
      // and keeps waiting for consent. If a platform instead delivers the
      // signal to process.on("SIGTERM"), the trusted path closes cleanly.
      // Both are lawful; what is forbidden is an exit produced by repetition.
      process.kill(app.process().pid, "SIGTERM");
      const signalExit = await Promise.race([
        exited,
        pause(5000).then(() => null),
      ]);
      if (signalExit === null) {
        assert.equal(await stageOf(data), "confirm-open");
        assert.equal(alive(app), true);
        // Consent is still the only way out through the user-facing path.
        await app.evaluate(() => {
          globalThis.__busy = false;
          globalThis.__rec.resolvers.forEach((r) => r({ response: 1 }));
          return true;
        });
        const exit = await Promise.race([
          exited,
          pause(30000).then(() => null),
        ]);
        assert.deepEqual(exit, { code: 0, signal: null });
      } else {
        // Trusted signal path: exited via handleSignal's serialized close —
        // assert the same clean post-conditions as a consented quit.
        assert.deepEqual(signalExit, { code: 0, signal: null });
      }
      await assertCleanExit(data, marker);
    } finally {
      await cleanup(app, data);
    }
  },
);

test(
  "declining the confirmation keeps the app live; a later quit re-asks and consents",
  { timeout: 240000, skip: skipReason || false },
  async () => {
    const wedged = await launchWedgedOnConfirm();
    assert.ok(wedged, "could not land the quit inside a busy window");
    const { app, data } = wedged;
    try {
      const marker = JSON.parse(
        await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
      );
      assert.equal(await stageOf(data), "confirm-open");
      // "Keep Working": the quit is cancelled and the session returns to
      // normal — process alive, marker retained, backend untouched.
      await app.evaluate(() => {
        globalThis.__rec.resolvers.forEach((r) => r({ response: 0 }));
        return true;
      });
      for (let i = 0; i < 50; i++) {
        if ((await stageOf(data)) === "quit-blocked") break;
        await pause(100);
      }
      assert.equal(await stageOf(data), "quit-blocked");
      assert.equal(alive(app), true, "a declined quit must not exit");
      assert.ok(
        JSON.parse(
          await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
        ).pid,
        "marker must remain while the app lives",
      );
      process.kill(marker.backendPid, 0);
      // A later quit request re-asks: a second confirmation opens on the
      // still-busy backend, and consent completes the close.
      await app.evaluate(({ app }) => {
        setTimeout(() => app.quit(), 0);
        return true;
      });
      for (let i = 0; i < 50; i++) {
        if ((await stageOf(data)) === "confirm-open") break;
        await pause(100);
      }
      assert.equal(await stageOf(data), "confirm-open");
      const calls = await app.evaluate(() => globalThis.__rec.calls);
      assert.equal(calls.length, 2, "cancelled quit must re-prompt");
      let exited = false;
      app.once("close", () => (exited = true));
      await app.evaluate(() => {
        globalThis.__busy = false;
        globalThis.__rec.resolvers.forEach((r) => r({ response: 1 }));
        return true;
      });
      for (let i = 0; i < 80 && !exited; i++) await pause(100);
      assert.equal(exited, true, "consent after a cancelled quit must exit");
      await assertCleanExit(data, marker);
    } finally {
      await cleanup(app, data);
    }
  },
);

// The idle case needs the quit to land while the backend is idle. The
// marker's ready flag proves idle was observed; a quit that still lands in a
// fresh busy window reaches confirm-open — consent, exit, and retry.
test(
  "idle quit skips the confirmation and exits directly",
  { timeout: 240000, skip: skipReason || false },
  async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const { app, data } = await launch();
      try {
        let ready = false;
        for (let i = 0; i < 300 && !ready; i++) {
          try {
            const m = JSON.parse(
              await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
            );
            ready = m.ready === true;
          } catch {}
          if (!ready) await pause(200);
        }
        assert.equal(ready, true, "backend must reach observed idle");
        let exited = false;
        app.once("close", () => (exited = true));
        await app.evaluate(({ app }) => {
          setTimeout(() => app.quit(), 0);
          return true;
        });
        for (let i = 0; i < 60 && !exited; i++) {
          if ((await stageOf(data)) === "confirm-open") break;
          await pause(100);
        }
        if (exited) {
          assert.equal(await stageOf(data), "quit-dispatch");
          return;
        }
        // Landed in a busy flap: consent so the attempt exits cleanly.
        await app
          .evaluate(() => {
            globalThis.__busy = false;
            globalThis.__rec.resolvers.forEach((r) => r({ response: 1 }));
            return true;
          })
          .catch(() => {});
        for (let i = 0; i < 80 && !exited; i++) await pause(100);
      } finally {
        await cleanup(app, data);
      }
    }
    assert.fail("quit never landed inside an idle window");
  },
);
