import test from "node:test";
import assert from "node:assert/strict";
import {
  bounded,
  failureCleanup,
  identity,
  killIdentity,
  sameIdentity,
  stderrCategory,
} from "../desktop/smoke-helpers.mjs";
import { spawn, fork } from "node:child_process";
import * as smokeHelpers from "../desktop/smoke-helpers.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

test("driver reports failed-first-window immediately even when a failed worker retains live handles", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prce-driver-failure-"));
  let child: ReturnType<typeof fork> | undefined;
  try {
    const fixture = path.join(dir, "worker.cjs");
    await writeFile(
      fixture,
      `process.send({type:'stage', stage:'failed-first-window'}); setInterval(() => {}, 1000);`,
    );
    child = fork(fixture, [], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const result = (smokeHelpers as any).driverResult;
    assert.equal(
      typeof result,
      "function",
      "supervisor needs a failure-message-aware result, not exit alone",
    );
    await assert.rejects(
      bounded("fixture-driver", () => result(child), 2000),
      /driver failed at failed-first-window/,
    );
    assert.equal(
      child.exitCode,
      null,
      "failure arrives before the retained worker exits",
    );
  } finally {
    if (child) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("smoke cleanup revalidates a real owned process group and rejects changed identity", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const exited = once(child, "exit");
  try {
    await once(child, "spawn");
    const observed = identity(child.pid!);
    assert.ok(observed);
    assert.equal(observed.parent, process.pid);
    assert.equal(observed.group, child.pid);
    assert.equal(sameIdentity(observed, identity(child.pid!)), true);
    assert.equal(
      killIdentity({ ...observed, started: "different-start-time" }),
      false,
    );
    assert.equal(
      killIdentity({ ...observed, command: "different-executable" }),
      false,
    );
    assert.equal(killIdentity({ ...observed, group: process.pid }), false);
    assert.equal(process.kill(child.pid!, 0), true);
    assert.equal(killIdentity(observed), true);
    await bounded("test-child-exit", () => exited, 2000);
    assert.equal(killIdentity(observed), false);
  } finally {
    child.kill("SIGKILL");
  }
});

test("smoke stderr diagnostics retain only fixed categories, never URLs or private payloads", () => {
  assert.equal(
    stderrCategory("Debugger listening on ws://127.0.0.1:123/secret"),
    "node-inspector-listening",
  );
  assert.equal(
    stderrCategory("[prce-smoke] startup-error-dialog"),
    "app-startup-error-dialog",
  );
  assert.equal(
    stderrCategory("[prce-smoke] startup-error-dialog private-token"),
    null,
  );
  assert.equal(
    stderrCategory("Authorization: private-token model source text"),
    null,
  );
  assert.equal(
    stderrCategory(
      "The SUID sandbox helper binary was found, but is not configured correctly",
    ),
    "sandbox-unavailable",
  );
});

test("smoke failure teardown bounds an app.close that never settles", async () => {
  const events: string[] = [];
  const start = performance.now();
  await failureCleanup(
    {
      close: () => {
        events.push("close");
        return new Promise(() => {});
      },
    },
    () => {
      events.push("kill-owned");
    },
    25,
  );
  assert.deepEqual(events, ["close", "kill-owned"]);
  assert.ok(performance.now() - start < 1000);
});

test("smoke stage timeout reports stage and consumes late rejection", async () => {
  await assert.rejects(
    bounded(
      "first-window",
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("private payload")), 40),
        ),
      10,
    ),
    /first-window deadline/,
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
});
