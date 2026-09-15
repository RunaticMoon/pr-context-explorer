import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
const electronExecutable = createRequire(import.meta.url)("electron");
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  bounded,
  driverResult,
  identity,
  killIdentity,
  stderrCategory,
} from "../../desktop/smoke-helpers.mjs";

// The separate driver is essential: racing a Playwright promise does not close
// its inspector sockets or cancel launch's internal graceful-close promise.
test(
  "real Electron window loads compiled app with sandbox, isolated read-only preload, external updater and graceful quit",
  { timeout: 90000 },
  async () => {
    const data = await realpath(
      await mkdtemp(path.join(tmpdir(), "prce-electron-")),
    );
    const appPath = path.resolve("desktop/build/app");
    let observedElectron,
      observedBackend,
      candidate,
      lastStage = "driver-start",
      succeeded = false;
    const worker = fork(
      new URL("./desktop-electron-worker.mjs", import.meta.url),
      [data],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        // Only this test's Playwright launcher; no machine-wide DEBUG or protocol bodies.
        env: { ...process.env, DEBUG: "pw:browser", DEBUG_COLORS: "0" },
      },
    );
    const log = (event) => console.error(`[desktop-smoke] ${event}`);
    const observe = async () => {
      if (candidate && !observedElectron) {
        const p = identity(candidate);
        if (
          p &&
          p.parent === worker.pid &&
          p.group === p.pid &&
          p.uid === process.getuid() &&
          p.command.startsWith(`${electronExecutable} `) &&
          p.command.includes(appPath) &&
          p.command.includes(`--user-data-dir=${data}`)
        )
          observedElectron = p;
      }
      try {
        const marker = JSON.parse(
          await readFile(path.join(data, "desktop-runtime.json"), "utf8"),
        );
        if (
          observedElectron &&
          marker.pid === observedElectron.pid &&
          marker.appPath === appPath &&
          !observedBackend
        ) {
          const p = identity(marker.backendPid);
          if (
            p &&
            p.parent === observedElectron.pid &&
            p.group === p.pid &&
            p.uid === process.getuid() &&
            p.command ===
              `${path.resolve("desktop/build/node/bin/node")} ${path.resolve("desktop/build/runtime/desktop/backend.js")}`
          )
            observedBackend = p;
        }
      } catch {
        /* No marker yet, or it was removed by normal quit. */
      }
    };
    // Drain both pipes continuously, retaining at most one bounded partial line.
    // Never forward arbitrary launch arguments, stderr, environment or IPC values.
    let partial = "";
    const diagnostics = new Set();
    worker.stdout.resume();
    worker.stderr.on("data", (chunk) => {
      partial += chunk.toString();
      const lines = partial.split("\n");
      partial = lines.pop().slice(-8192);
      for (const line of lines) {
        const match = line.match(/<launched> pid=(\d+)/);
        if (match && !candidate) candidate = Number(match[1]);
        const category = stderrCategory(line);
        if (category && !diagnostics.has(category)) {
          diagnostics.add(category);
          log(category);
        }
      }
    });
    let observing = false;
    const poll = setInterval(() => {
      if (observing) return;
      observing = true;
      void observe().finally(() => {
        observing = false;
      });
    }, 100);
    // Reaping is independent of the assertion result. Only driverResult owns
    // spawn-error rejection, so there is no second unhandled rejected promise.
    const exited = new Promise((resolve) => {
      worker.once("exit", (code, signal) => resolve({ code, signal }));
    });
    const outcome = driverResult(worker);
    worker.on("message", (message) => {
      if (message?.type === "stage" && /^[a-z-]{1,60}$/.test(message.stage)) {
        lastStage = message.stage;
        log(lastStage);
      }
      if (message?.type === "electron-pid" && Number.isSafeInteger(message.pid))
        candidate = message.pid;
      if (message?.type === "success") succeeded = true;
    });
    try {
      const result = await bounded(
        "overall-including-teardown",
        () => outcome,
        70000,
      );
      assert.equal(result.code, 0, `driver failed at ${lastStage}`);
      assert.equal(result.signal, null);
      assert.equal(
        succeeded,
        true,
        "driver must complete every normal-launch/quit assertion",
      );
    } catch (error) {
      log(`failure-stage=${lastStage}`);
      log(`diagnostics=${[...diagnostics].join(",") || "none"}`);
      await bounded("ownership-observation", observe, 2000).catch(() => {});
      log(
        `owned-electron=${!!observedElectron} owned-backend=${!!observedBackend}`,
      );
      // Failure only. Each PID is revalidated against its previously observed
      // start time, executable/arguments, uid and private process group.
      for (const [kind, observed] of [
        ["backend", observedBackend],
        ["electron", observedElectron],
      ]) {
        try {
          log(`${kind}-force-cleanup=${killIdentity(observed)}`);
        } catch {
          log(`${kind}-force-cleanup=signal-denied`);
        }
      }
      // This exact ChildProcess is ours even when Electron launch never returned.
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill("SIGKILL");
      await bounded("driver-reap", () => exited, 2000).catch(() => {});
      throw error;
    } finally {
      clearInterval(poll);
      worker.stdout.destroy();
      worker.stderr.destroy();
      if (worker.connected) worker.disconnect();
      worker.unref();
      await bounded(
        "remove-test-data",
        () => rm(data, { recursive: true, force: true }),
        2000,
      );
    }
  },
);
