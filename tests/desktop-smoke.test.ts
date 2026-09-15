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
import { spawn } from "node:child_process";
import { once } from "node:events";

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
