import { test } from "node:test";
import assert from "node:assert/strict";
import { waitForFixture } from "./wait-for-fixture.ts";

test("fixture gates report early operation failure and timeout instead of hanging", async () => {
  const never = new Promise<void>(() => {});
  await assert.rejects(
    waitForFixture(never, Promise.reject(Error("FAKE_PRIVATE_DETAIL"))),
    { message: "fixture operation failed before its gate" },
  );
  await assert.rejects(waitForFixture(never, Promise.resolve()), {
    message: "fixture operation completed before its gate",
  });
  await assert.rejects(waitForFixture(never, undefined, 5), {
    message: "fixture gate was not reached",
  });
  await waitForFixture(Promise.resolve(), never);
});
