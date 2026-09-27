import test from "node:test";
import assert from "node:assert/strict";
import {
  PublicUpdater,
  type PublicUpdaterOptions,
} from "../desktop/public-update/index.ts";
import {
  UpdateError,
  type UpdateErrorStage,
} from "../desktop/public-update/policy.ts";
import { validatePlan } from "../desktop/public-update/helper.ts";

function updater(overrides: Partial<PublicUpdaterOptions> = {}) {
  return new PublicUpdater({
    currentVersion: "0.5.1",
    appPath: "/Applications/PR Context Explorer.app",
    dataDir: "/nonexistent",
    nodePath: "/untrusted/node",
    helperPath: "/untrusted/helper",
    isBusy: () => false,
    ...overrides,
  });
}

// `run` is the single mapping point from an action failure to the preserved
// status code/stage. Exercising it directly pins the contract without
// depending on filesystem permissions or the platform ACL helper.
const runAt = (
  u: PublicUpdater,
  stage: UpdateErrorStage,
  action: (signal: AbortSignal) => Promise<unknown>,
): Promise<unknown> =>
  (
    u as unknown as {
      run(
        stage: UpdateErrorStage,
        action: (signal: AbortSignal) => Promise<unknown>,
      ): Promise<unknown>;
    }
  ).run(stage, action);

test("service refuses busy install and never accepts renderer configuration", async () => {
  const u = new PublicUpdater({
    currentVersion: "0.5.1",
    appPath: "/Applications/PR Context Explorer.app",
    dataDir: "/nonexistent",
    nodePath: "/untrusted/node",
    helperPath: "/untrusted/helper",
    isBusy: () => true,
  });
  await assert.rejects(u.prepareInstall(), /BUSY/);
  assert.equal(u.status.phase, "error");
  await u.close();
  await assert.rejects(u.check(), /CLOSED/);
});

test("invalid handoff plans reject unknown keys and path escape", () => {
  for (const p of [
    {},
    { schemaVersion: 1, url: "https://evil.test" },
    {
      schemaVersion: 1,
      appPath: "/tmp/foreign.app",
      workDir: "/tmp/../../etc",
    },
  ])
    assert.throws(() => validatePlan(p, "/tmp/plan.json"));
});

test("non-UpdateError errno during download is preserved with its stage", async () => {
  const u = updater();
  try {
    await assert.rejects(
      runAt(u, "download", async () => {
        throw Object.assign(new Error("x"), { code: "EACCES" });
      }),
      (e: unknown) =>
        e instanceof UpdateError &&
        e.code === "EACCES" &&
        e.errorStage === "download",
    );
    assert.deepEqual(u.status, {
      phase: "error",
      errorCode: "EACCES",
      errorStage: "download",
    });
  } finally {
    await u.close();
  }
});

test("uncoded failure keeps UPDATE_FAILED and its stage", async () => {
  const u = updater();
  try {
    await assert.rejects(
      runAt(u, "prepare", async () => {
        throw new Error("boom");
      }),
      (e: unknown) =>
        e instanceof UpdateError &&
        e.code === "UPDATE_FAILED" &&
        e.errorStage === "prepare",
    );
    assert.deepEqual(u.status, {
      phase: "error",
      errorCode: "UPDATE_FAILED",
      errorStage: "prepare",
    });
  } finally {
    await u.close();
  }
});

test("abort still reports CANCELLED with its stage", async () => {
  const u = updater();
  try {
    const pending = runAt(
      u,
      "download",
      (signal) =>
        new Promise<never>((_, reject) => {
          const abort = () => reject(new UpdateError("CANCELLED"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
    );
    (
      u as unknown as { controller: AbortController }
    ).controller.abort();
    await assert.rejects(
      pending,
      (e: unknown) =>
        e instanceof UpdateError &&
        e.code === "CANCELLED" &&
        e.errorStage === "download",
    );
    assert.deepEqual(u.status, {
      phase: "cancelled",
      errorCode: "CANCELLED",
      errorStage: "download",
    });
  } finally {
    await u.close();
  }
});

test("public operations report their failing stage", async () => {
  const noManifest = updater();
  const busy = updater({ isBusy: () => true });
  const closed = updater();
  try {
    await assert.rejects(noManifest.download(), /NO_UPDATE/);
    assert.deepEqual(noManifest.status, {
      phase: "error",
      errorCode: "NO_UPDATE",
      errorStage: "download",
    });
    await assert.rejects(busy.prepareInstall(), /BUSY/);
    assert.deepEqual(busy.status, {
      phase: "error",
      errorCode: "BUSY",
      errorStage: "prepare",
    });
    await closed.close();
    await assert.rejects(
      closed.check(),
      (e: unknown) =>
        e instanceof UpdateError &&
        e.code === "CLOSED" &&
        e.errorStage === "check",
    );
  } finally {
    await noManifest.close();
    await busy.close();
    await closed.close();
  }
});

test("a later state replaces stale error code and stage", async () => {
  const u = updater();
  try {
    await assert.rejects(
      runAt(u, "download", async () => {
        throw Object.assign(new Error("x"), { code: "EACCES" });
      }),
    );
    assert.equal(u.status.errorCode, "EACCES");
    assert.equal(u.status.errorStage, "download");
    // The whole status is replaced on every emission, so a subsequent
    // successful/later state can never carry the previous failure detail.
    await u.cancel();
    assert.deepEqual(u.status, { phase: "cancelled" });
    assert.equal(u.status.errorCode, undefined);
    assert.equal(u.status.errorStage, undefined);
  } finally {
    await u.close();
  }
});
