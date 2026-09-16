import "./public-update-test-support.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { replaceTransaction } from "../desktop/public-update/transaction.ts";
import {
  privateDirectory,
  writePrivate,
  readPrivate,
} from "../desktop/public-update/files.ts";
import { UpdateError } from "../desktop/public-update/policy.ts";
import {
  reportHelperFailure,
  updatePlanRequested,
  updateProbeActive,
  sendHelperMessage,
  stopFailedBoot,
  phaseMarker,
  processIdentity,
} from "../desktop/public-update/helper.ts";

const tmp = () =>
  realpath(os.tmpdir()).then((t) => mkdtemp(path.join(t, "public-diag-")));
const e2eModule = new URL("./e2e/public-update-mac.mjs", import.meta.url).href;

async function transactionFixture(root: string) {
  const app = path.join(root, "PR Context Explorer.app"),
    work = await privateDirectory(path.join(root, ".prce-update-diag")),
    staged = path.join(work, "PR Context Explorer.app");
  await mkdir(app);
  await mkdir(staged);
  await writeFile(path.join(app, "sentinel"), "old");
  await writeFile(path.join(staged, "sentinel"), "new");
  return {
    app,
    work,
    staged,
    plan: {
      appPath: app,
      stagedApp: staged,
      workDir: work,
      version: "0.6.0",
      oldVersion: "0.5.1",
    },
  };
}

test("uncertain rollback records primary and cleanup codes and preserves backup+lock", async () => {
  const root = await tmp();
  try {
    const t = await transactionFixture(root);
    const steps: string[] = [];
    await assert.rejects(
      replaceTransaction(t.plan, {
        validate: async () => {},
        launch: async () => {
          throw new UpdateError("STARTUP_TIMEOUT");
        },
        stopFailedLaunch: async () => {
          throw new UpdateError("STARTUP_STOP_TIMEOUT");
        },
        rollbackLaunch: async () => {},
        checkpoint: async (s) => void steps.push(s),
      }),
      /ROLLBACK_FAILED/,
    );
    const failure = (await readPrivate(
      path.join(t.work, "failure.json"),
    )) as Record<string, unknown>;
    assert.equal(failure.phase, "failed");
    assert.equal(failure.code, "STARTUP_TIMEOUT");
    assert.equal(failure.rollbackCode, "STARTUP_STOP_TIMEOUT");
    assert.equal(failure.stage, "stop-failed");
    // Uncertain state: no result claimed, backup and lock kept for recovery.
    assert.equal(
      await lstat(path.join(t.work, "result.json")).catch(() => null),
      null,
    );
    assert.ok(
      await lstat(path.join(t.work, "previous.app")).catch(() => null),
      "old bundle backup must survive an uncertain rollback",
    );
    assert.ok(
      await lstat(path.join(root, ".prce-public-update.lock")).catch(
        () => null,
      ),
      "uncertain rollback keeps the update lock",
    );
    assert.equal(await readFile(path.join(t.app, "sentinel"), "utf8"), "new");
    assert.deepEqual(steps, [
      "validated",
      "old-renamed",
      "new-renamed",
      "restoring",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rolled-back receipt is durable before rejection and releases the lock", async () => {
  const root = await tmp();
  try {
    const t = await transactionFixture(root);
    const steps: string[] = [],
      relaunches: string[] = [];
    await assert.rejects(
      replaceTransaction(t.plan, {
        validate: async () => {},
        launch: async () => {
          throw new UpdateError("STARTUP_FAILED");
        },
        stopFailedLaunch: async () => {},
        rollbackLaunch: async (app) => void relaunches.push(app),
        checkpoint: async (s) => void steps.push(s),
      }),
      /STARTUP_FAILED/,
    );
    // Ordering contract: the durable result exists at the moment of rejection.
    assert.deepEqual(
      await readPrivate(path.join(t.work, "result.json")),
      { phase: "rolled-back" },
    );
    assert.equal(await readFile(path.join(t.app, "sentinel"), "utf8"), "old");
    assert.deepEqual(relaunches, [t.app]);
    assert.equal(
      await lstat(path.join(root, ".prce-public-update.lock")).catch(
        () => null,
      ),
      null,
    );
    assert.deepEqual(steps, [
      "validated",
      "old-renamed",
      "new-renamed",
      "restoring",
      "relaunching",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function spawnChild(ignoreTerm: boolean) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `${
        ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ""
      }process.stdout.write("ready\\n");setInterval(()=>{},1000)`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    // A ready handshake, not the spawn event: a SIGTERM-ignoring child must
    // have installed its handler before the test may signal it.
    await new Promise((resolve, reject) => {
      child.stdout!.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("child exited before ready")));
    });
  } catch (error) {
    await killAndReap(child);
    throw error;
  }
  return child;
}
async function killAndReap(child: ChildProcess) {
  const exited =
    child.exitCode === null && child.signalCode === null
      ? new Promise((resolve) => child.once("exit", resolve))
      : Promise.resolve();
  try {
    child.kill("SIGKILL");
  } catch {}
  await exited;
}
async function childIdentity(pid: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const identity = await processIdentity(pid).catch(() => null);
    if (identity) return identity;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test("real-process stop contract: a SIGTERM-responsive failed launch is replaced", async () => {
  const root = await tmp();
  const child = await spawnChild(false);
  try {
    const t = await transactionFixture(root);
    await assert.rejects(
      replaceTransaction(t.plan, {
        validate: async () => {},
        launch: async () => {
          throw new UpdateError("STARTUP_FAILED");
        },
        // Production stop semantics against a real process identity.
        stopFailedLaunch: () =>
          stopFailedBoot(async () => {
            const identity = await childIdentity(child.pid!);
            return identity
              ? { pid: child.pid!, identity, nonce: "n", version: "0.6.0" }
              : null;
          }),
        rollbackLaunch: async () => {},
        checkpoint: async () => {},
      }),
      /STARTUP_FAILED/,
    );
    assert.equal(await processIdentity(child.pid!), null);
    assert.deepEqual(
      await readPrivate(path.join(t.work, "result.json")),
      { phase: "rolled-back" },
    );
    assert.equal(await readFile(path.join(t.app, "sentinel"), "utf8"), "old");
  } finally {
    await killAndReap(child);
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real-process stop contract: an unkillable failed launch keeps backup+lock",
  { timeout: 30000 },
  async () => {
    const root = await tmp();
    const child = await spawnChild(true);
    try {
      const t = await transactionFixture(root);
      await assert.rejects(
        replaceTransaction(t.plan, {
          validate: async () => {},
          launch: async () => {
            throw new UpdateError("STARTUP_TIMEOUT");
          },
          stopFailedLaunch: () =>
            stopFailedBoot(async () => {
              const identity = await childIdentity(child.pid!);
              return identity
                ? { pid: child.pid!, identity, nonce: "n", version: "0.6.0" }
                : null;
            }),
          rollbackLaunch: async () => {},
          checkpoint: async () => {},
        }),
        /ROLLBACK_FAILED/,
      );
      const failure = (await readPrivate(
        path.join(t.work, "failure.json"),
      )) as Record<string, unknown>;
      assert.equal(failure.code, "STARTUP_TIMEOUT");
      assert.equal(failure.rollbackCode, "STARTUP_STOP_TIMEOUT");
      assert.equal(failure.stage, "stop-failed");
      assert.ok(
        await lstat(path.join(t.work, "previous.app")).catch(() => null),
      );
      assert.ok(
        await lstat(path.join(root, ".prce-public-update.lock")).catch(
          () => null,
        ),
      );
    } finally {
      await killAndReap(child);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("worker failure receipts are bounded, exclusive, and never mask a result", async () => {
  const root = await tmp();
  try {
    const work = await privateDirectory(
        path.join(root, `.prce-update-${"0".repeat(64)}`),
      ),
      planPath = path.join(work, "plan.json");
    assert.equal(
      await reportHelperFailure(planPath, new UpdateError("STARTUP_TIMEOUT")),
      "STARTUP_TIMEOUT",
    );
    const failure = (await readPrivate(
      path.join(work, "failure.json"),
    )) as Record<string, unknown>;
    assert.equal(failure.phase, "failed");
    assert.equal(failure.code, "STARTUP_TIMEOUT");
    // A second report never replaces the first durable failure receipt.
    assert.equal(
      await reportHelperFailure(planPath, new UpdateError("EXIT_TIMEOUT")),
      "EXIT_TIMEOUT",
    );
    assert.equal(
      ((
        await readPrivate(path.join(work, "failure.json"))
      ) as Record<string, unknown>).code,
      "STARTUP_TIMEOUT",
    );
    // Uncoded errors collapse to the generic code; bounded errno codes survive.
    assert.equal(
      await reportHelperFailure(planPath, Error("plain message")),
      "WORKER_ERROR",
    );
    assert.equal(
      await reportHelperFailure(
        planPath,
        Object.assign(Error("io"), { code: "EACCES" }),
      ),
      "EACCES",
    );
    // A committed transaction outcome is authoritative: no failure receipt.
    const work2 = await privateDirectory(
      path.join(root, `.prce-update-${"1".repeat(64)}`),
    );
    await writePrivate(path.join(work2, "result.json"), {
      phase: "rolled-back",
    });
    assert.equal(
      await reportHelperFailure(
        path.join(work2, "plan.json"),
        new UpdateError("STARTUP_FAILED"),
      ),
      "STARTUP_FAILED",
    );
    assert.equal(
      await lstat(path.join(work2, "failure.json")).catch(() => null),
      null,
    );
    // An unsafe plan path writes nothing anywhere.
    assert.equal(
      await reportHelperFailure("plan.json", new UpdateError("UNSAFE_PLAN")),
      "UNSAFE_PLAN",
    );
    assert.equal(
      await lstat(path.join(root, "failure.json")).catch(() => null),
      null,
    );
    // A plan path outside a transaction-shaped workDir writes nothing either:
    // failure receipts stay inside the private `.prce-update-<nonce>` journal.
    const stray = await privateDirectory(path.join(root, ".prce-update-stray"));
    assert.equal(
      await reportHelperFailure(
        path.join(stray, "plan.json"),
        new UpdateError("UNSAFE_PLAN"),
      ),
      "UNSAFE_PLAN",
    );
    assert.equal(
      await lstat(path.join(stray, "failure.json")).catch(() => null),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase markers validate labels strictly but persist best-effort", async () => {
  const root = await tmp();
  try {
    const work = await privateDirectory(path.join(root, ".prce-update-diag"));
    const mark = phaseMarker(work);
    await mark("old-exited");
    const marker = (await readPrivate(
      path.join(work, "phase.old-exited"),
    )) as Record<string, unknown>;
    assert.equal(marker.phase, "old-exited");
    assert.equal(typeof marker.at, "number");
    // A malformed programmer-supplied label still fails loudly.
    await assert.rejects(mark("UPPER"), /UNSAFE_PLAN/);
    await assert.rejects(mark("../escape"), /UNSAFE_PLAN/);
    // Marker persistence is diagnostics-only: a duplicate single-write entry
    // (EEXIST) and a vanished work directory resolve instead of aborting an
    // update, stop, restore or relaunch.
    await mark("old-exited");
    await rm(work, { recursive: true });
    await mark("restoring");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failing phase markers never abort rollback: restore, relaunch and durable result still run", async () => {
  const root = await tmp();
  try {
    const t = await transactionFixture(root);
    // Every marker publication collides with a pre-existing entry: real EEXIST
    // write failures at the real phaseMarker boundary, not a mocked port.
    for (const step of [
      "validated",
      "old-renamed",
      "new-renamed",
      "started",
      "restoring",
      "relaunching",
    ])
      await writeFile(path.join(t.work, `phase.${step}`), "{}");
    const relaunches: string[] = [];
    let stopped = false;
    await assert.rejects(
      replaceTransaction(t.plan, {
        validate: async () => {},
        launch: async () => {
          throw new UpdateError("STARTUP_FAILED");
        },
        stopFailedLaunch: async () => {
          stopped = true;
        },
        rollbackLaunch: async (app) => void relaunches.push(app),
        checkpoint: phaseMarker(t.work),
      }),
      /STARTUP_FAILED/,
    );
    assert.equal(stopped, true);
    assert.equal(await readFile(path.join(t.app, "sentinel"), "utf8"), "old");
    assert.deepEqual(relaunches, [t.app]);
    assert.deepEqual(await readPrivate(path.join(t.work, "result.json")), {
      phase: "rolled-back",
    });
    assert.equal(
      await lstat(path.join(root, ".prce-public-update.lock")).catch(
        () => null,
      ),
      null,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failing phase markers never abort a forward update", async () => {
  const root = await tmp();
  try {
    const t = await transactionFixture(root);
    for (const step of [
      "validated",
      "old-renamed",
      "new-renamed",
      "started",
    ])
      await writeFile(path.join(t.work, `phase.${step}`), "{}");
    await replaceTransaction(t.plan, {
      validate: async () => {},
      launch: async () => {},
      rollbackLaunch: async () => {},
      checkpoint: phaseMarker(t.work),
    });
    assert.equal(await readFile(path.join(t.app, "sentinel"), "utf8"), "new");
    assert.deepEqual(await readPrivate(path.join(t.work, "result.json")), {
      phase: "installed",
      version: "0.6.0",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update launch detection matches the exact fixed plan argument", () => {
  const argv = ["node", "app"];
  assert.equal(updatePlanRequested(argv), false);
  assert.equal(
    updatePlanRequested([...argv, "--prce-update-plan=/p/plan.json"]),
    true,
  );
  assert.equal(updatePlanRequested([...argv, "--prce-update-plan="]), true);
  assert.equal(updatePlanRequested([...argv, "--prce-update-plan-x"]), false);
  assert.equal(
    updatePlanRequested([...argv, "--prce-update-plan=a", "--prce-update-plan=b"]),
    true,
  );
});

test("dialog suppression is bound to the pre-commit probe window only", () => {
  // State transition: a plan-driven launch starts as an uncommitted probe.
  let committed = false;
  // Pre-commit: no user input may be awaited — the helper must observe exit.
  assert.equal(updateProbeActive(true, committed), true);
  // Startup commit turns the probe into the user's ordinary session...
  committed = true;
  assert.equal(updateProbeActive(true, committed), false);
  // ...irreversibly: backend death resets startup readiness, never this flag,
  // so post-commit failures again show the normal user-facing messages.
  assert.equal(updateProbeActive(true, committed), false);
  // Ordinary launches never suppress failure reporting.
  assert.equal(updateProbeActive(false, false), false);
  assert.equal(updateProbeActive(false, true), false);
});

test("receipt wait races worker termination against durable receipts", async () => {
  const { awaitWorkerReceipt } = await import(e2eModule);
  const root = await tmp();
  const work = path.join(root, "w");
  await mkdir(work);
  const exitOf = (child: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
  let stuck: ChildProcess | null = null;
  try {
    // A worker that exits without a receipt must end the wait promptly.
    const dead = spawn(process.execPath, ["-e", "process.exit(7)"], {
      stdio: "ignore",
    });
    const t0 = Date.now();
    assert.equal(
      (
        await awaitWorkerReceipt({
          work,
          done: exitOf(dead),
          deadline: Date.now() + 60000,
        })
      ).kind,
      "exit",
    );
    assert.ok(Date.now() - t0 < 30000, "dead worker must not burn the budget");
    // A durable result is observed while the worker is still finishing.
    const slow = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>process.exit(0),400)"],
      { stdio: "ignore" },
    );
    const done = exitOf(slow);
    await writeFile(
      path.join(work, "result.json"),
      JSON.stringify({ phase: "installed", version: "0.6.0" }),
    );
    const receipt = await awaitWorkerReceipt({
      work,
      done,
      deadline: Date.now() + 60000,
    });
    assert.equal(receipt.kind, "result");
    await done;
    // A live worker with no receipts observes its bound.
    stuck = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const empty = path.join(root, "empty");
    await mkdir(empty);
    assert.equal(
      (
        await awaitWorkerReceipt({
          work: empty,
          done: exitOf(stuck),
          deadline: Date.now() + 700,
        })
      ).kind,
      "timeout",
    );
    // A durable receipt landing at the deadline boundary is still observed:
    // the wait re-checks result/failure once before declaring timeout.
    const late = path.join(root, "late");
    await mkdir(late);
    const lateWrite = setTimeout(() => {
      void writeFile(
        path.join(late, "result.json"),
        JSON.stringify({ phase: "installed", version: "0.6.0" }),
      );
    }, 50);
    try {
      assert.equal(
        (
          await awaitWorkerReceipt({
            work: late,
            done: exitOf(stuck),
            deadline: Date.now() + 40,
          })
        ).kind,
        "result",
      );
    } finally {
      clearTimeout(lateWrite);
    }
  } finally {
    // No subprocess may outlive the test on assertion failure.
    if (stuck) await killAndReap(stuck);
    await rm(root, { recursive: true, force: true });
  }
});

test("worker receipt snapshot is bounded to fixed labels, codes and booleans", async () => {
  const { receiptSnapshot } = await import(e2eModule);
  const root = await tmp();
  const work = path.join(root, "work");
  await mkdir(work);
  try {
    await writeFile(path.join(work, "phase.validated"), "{}");
    await writeFile(path.join(work, "phase.old-renamed"), "{}");
    await writeFile(path.join(work, "plan.json"), "{}");
    await writeFile(
      path.join(work, "failure.json"),
      JSON.stringify({
        phase: "failed",
        code: "STARTUP_TIMEOUT",
        rollbackCode: "STARTUP_STOP_TIMEOUT",
        stage: "stop-failed",
        detail: "leaks /tmp/secret and raw stderr",
      }),
    );
    const snap = await receiptSnapshot(work, { code: 1, signal: null });
    assert.deepEqual(snap.exit, { code: 1, signal: null });
    assert.deepEqual(snap.receipts, {
      plan: true,
      launch: false,
      boot: false,
      startup: false,
      commit: false,
      result: false,
      failure: true,
      cancel: false,
    });
    assert.deepEqual(snap.phases, ["old-renamed", "validated"]);
    assert.deepEqual(snap.failure, {
      code: "STARTUP_TIMEOUT",
      rollbackCode: "STARTUP_STOP_TIMEOUT",
      stage: "stop-failed",
    });
    assert.equal(JSON.stringify(snap).includes("secret"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness diagnostics settle deterministically when state reads fail", async () => {
  const { boundedState } = await import(e2eModule);
  assert.equal(
    await boundedState(() => Promise.reject(new Error("EACCES"))),
    "unavailable",
  );
  assert.equal(
    await boundedState(() => {
      throw new Error("sync read failure");
    }),
    "unavailable",
  );
  assert.deepEqual(await boundedState(async () => ({ a: 1 })), { a: 1 });
  // The exact readiness-callback shape: boundedState().then(reject) must
  // settle and must never produce an unhandled rejection.
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const settled = await new Promise<Error>((resolve) => {
      void boundedState(() =>
        Promise.reject(new Error("state read failed")),
      ).then((state: unknown) =>
        resolve(
          new Error(`Helper exited before ready ${JSON.stringify(state)}`),
        ),
      );
    });
    assert.match(settled.message, /unavailable/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("cleanup failure fails the run but never replaces a primary failure", async () => {
  const { cleanupPreservingFailure } = await import(e2eModule);
  const reported: string[] = [];
  // Primary failure in flight: the cleanup cause survives only as bounded
  // evidence; the original error keeps propagating.
  await cleanupPreservingFailure(
    true,
    async () => {
      throw Object.assign(new Error("timed out"), { code: "ESTALE" });
    },
    (e: unknown) =>
      reported.push(
        (e as NodeJS.ErrnoException).code ?? "CLEANUP_FAILED",
      ),
  );
  assert.deepEqual(reported, ["ESTALE"]);
  // No primary failure: a cleanup failure must still fail the run.
  await assert.rejects(
    cleanupPreservingFailure(
      false,
      async () => {
        throw new Error("cleanup failed");
      },
      () => {},
    ),
    /cleanup failed/,
  );
  // Clean cleanup resolves normally either way.
  await cleanupPreservingFailure(false, async () => {}, () => {});
  await cleanupPreservingFailure(true, async () => {}, () => {});
});

test("helper failure announcement is best-effort on a closing IPC channel", () => {
  const original = process.send;
  const sent: unknown[] = [];
  const proc = process as { send?: unknown };
  try {
    // No channel at all: announcing a failure must not throw.
    delete proc.send;
    sendHelperMessage({ type: "failed", code: "STARTUP_FAILED" });
    // Synchronous channel failure is contained.
    proc.send = () => {
      throw new Error("channel closed");
    };
    sendHelperMessage({ type: "failed", code: "STARTUP_FAILED" });
    // Asynchronous send errors are delivered to the callback, never raised as
    // an uncaught raw-stderr failure in the detached helper.
    proc.send = (
      _message: unknown,
      callback?: (error: Error | null) => void,
    ) => {
      callback?.(new Error("EPIPE"));
      return false;
    };
    sendHelperMessage({ type: "failed", code: "STARTUP_FAILED" });
    // A healthy channel still carries the bounded message.
    proc.send = (message: unknown) => {
      sent.push(message);
      return true;
    };
    sendHelperMessage({ type: "failed", code: "STARTUP_FAILED" });
    assert.deepEqual(sent, [{ type: "failed", code: "STARTUP_FAILED" }]);
  } finally {
    if (original === undefined) delete proc.send;
    else proc.send = original;
  }
});
