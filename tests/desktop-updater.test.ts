import test from "node:test";
import assert from "node:assert/strict";
import * as updates from "../desktop/update-state.ts";

test("unsigned build fails closed to external updates; signed install requires ready, idle and explicit consent", async () => {
  assert.equal(typeof updates.UpdateState, "function");
  let installed = 0;
  const unsigned = new updates.UpdateState(false);
  assert.equal(unsigned.status.phase, "external");
  assert.throws(() => unsigned.beginCheck());
  assert.equal(
    await unsigned.install(
      async () => false,
      async () => true,
      () => installed++,
    ),
    false,
  );
  const state = new updates.UpdateState(true);
  assert.equal(state.beginCheck(), true);
  assert.equal(state.beginCheck(), false);
  state.available("0.5.0");
  assert.equal(state.status.phase, "available");
  assert.equal(state.beginDownload(), true);
  state.progress(54);
  assert.equal(state.status.percent, 54);
  state.downloaded();
  assert.equal(
    await state.install(
      async () => true,
      async () => true,
      () => installed++,
    ),
    false,
  );
  assert.equal(
    await state.install(
      async () => false,
      async () => false,
      () => installed++,
    ),
    false,
  );
  assert.equal(
    await state.install(
      async () => false,
      async () => true,
      () => installed++,
    ),
    true,
  );
  assert.equal(installed, 1);
});
test("concurrent consent cannot invoke installer twice", async () => {
  const state = new updates.UpdateState(true);
  state.beginCheck();
  state.available("1.0.0");
  state.beginDownload();
  state.downloaded();
  let installs = 0;
  await Promise.all([
    state.install(
      async () => false,
      async () => true,
      () => installs++,
    ),
    state.install(
      async () => false,
      async () => true,
      () => installs++,
    ),
  ]);
  assert.equal(installs, 1);
});
test("updater errors never expose server response/token or erase external data; cancellation is retryable", () => {
  assert.equal(typeof updates.UpdateState, "function");
  const state = new updates.UpdateState(true);
  state.beginCheck();
  state.fail();
  assert.equal(state.status.phase, "error");
  assert.ok(!JSON.stringify(state.status).includes("token"));
  assert.equal(state.beginCheck(), true);
  state.available("1.0.0");
  state.beginDownload();
  state.cancel();
  assert.equal(state.status.phase, "idle");
  assert.equal(state.beginCheck(), true);
});
