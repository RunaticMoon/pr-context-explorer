import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  AutomaticUpdates,
  UPDATE_CHECK_INTERVAL,
  canCheckForUpdate,
} from "../desktop/automatic-updates.ts";
import type { Phase } from "../desktop/public-update/index.ts";
import type { Preferences } from "../desktop/preferences.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(
  t: TestContext,
  initial: Preferences = { autoCheck: true, autoDownload: false },
) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let preferences = initial,
    phase: Phase = "idle",
    active = true;
  const calls: string[] = [];
  let perform = async (action: string) => {
    calls.push(action);
  };
  const scheduler = new AutomaticUpdates({
    active: () => active,
    preferences: () => preferences,
    phase: () => phase,
    command: (action) => perform(action),
  });
  t.after(() => scheduler.stop());
  return {
    scheduler,
    calls,
    phase(value: Phase) {
      phase = value;
    },
    active(value: boolean) {
      active = value;
    },
    perform(value: typeof perform) {
      perform = value;
    },
    preferences(value: Preferences) {
      const previous = preferences;
      preferences = value;
      scheduler.preferencesChanged(previous);
    },
    async tick(ms: number) {
      t.mock.timers.tick(ms);
      await settle();
    },
  };
}
test("automatic checks defer startup, repeat once and stop immediately when disabled", async (t) => {
  const f = fixture(t);
  f.scheduler.start();
  await f.tick(29_999);
  assert.deepEqual(f.calls, []);
  await f.tick(1);
  assert.deepEqual(f.calls, ["check"]);
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.deepEqual(f.calls, ["check", "check"]);
  f.preferences({ autoCheck: false, autoDownload: false });
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.equal(f.calls.length, 2);
  f.preferences({ autoCheck: true, autoDownload: false });
  await f.tick(0);
  assert.equal(f.calls.length, 3);
});
test("enabling automatic download immediately fetches an already available version, even with checks off", async (t) => {
  const f = fixture(t, { autoCheck: false, autoDownload: false });
  f.phase("available");
  f.scheduler.start();
  f.preferences({ autoCheck: false, autoDownload: true });
  await f.tick(0);
  assert.deepEqual(f.calls, ["download"]);
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.deepEqual(f.calls, ["download"]);
});
test("periodic or manually requested checks preserve downloaded/installing updates", async (t) => {
  const f = fixture(t);
  f.scheduler.start();
  for (const phase of [
    "checking",
    "downloading",
    "downloaded",
    "preparing",
    "ready",
  ] as Phase[]) {
    assert.equal(canCheckForUpdate(phase), false);
    f.phase(phase);
    await f.tick(UPDATE_CHECK_INTERVAL);
  }
  assert.deepEqual(f.calls, []);
  f.phase("error");
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.deepEqual(f.calls, ["check"]);
});
test("network failure remains retryable; stopping an in-flight check cannot rearm a timer", async (t) => {
  const f = fixture(t);
  f.perform(async () => {
    f.calls.push("check");
    throw Error("offline");
  });
  f.scheduler.start();
  await f.tick(30_000);
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.equal(f.calls.length, 2);
  let release!: () => void;
  f.perform(async () => {
    f.calls.push("check");
    await new Promise<void>((r) => {
      release = r;
    });
  });
  await f.tick(UPDATE_CHECK_INTERVAL);
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.equal(f.calls.length, 3);
  f.scheduler.stop();
  release();
  await settle();
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.equal(f.calls.length, 3);
});
test("backend failure suppresses automatic network work", async (t) => {
  const f = fixture(t);
  f.scheduler.start();
  f.active(false);
  await f.tick(30_000);
  assert.deepEqual(f.calls, []);
});

test("preference changes during a pending check take effect without another periodic wait", async (t) => {
  const f = fixture(t);
  let release!: () => void;
  f.perform(async (action) => {
    f.calls.push(action);
    if (action === "check") {
      await new Promise<void>((r) => {
        release = r;
      });
      f.phase("available");
    }
  });
  f.scheduler.start();
  await f.tick(30_000);
  f.preferences({ autoCheck: false, autoDownload: false });
  release();
  await settle();
  await f.tick(UPDATE_CHECK_INTERVAL);
  assert.deepEqual(f.calls, ["check"]);
  f.preferences({ autoCheck: false, autoDownload: true });
  await f.tick(0);
  assert.deepEqual(f.calls, ["check", "download"]);
});
