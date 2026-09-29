import test from "node:test";
import assert from "node:assert/strict";
import { describeUpdateFailure } from "../desktop/public-update-status.ts";
import { UpdateError } from "../desktop/public-update/policy.ts";

test("an UpdateError keeps its own code and stage over the fallback", () => {
  assert.deepEqual(
    describeUpdateFailure(new UpdateError("HASH_MISMATCH", "download"), "check"),
    { code: "HASH_MISMATCH", stage: "download" },
  );
});

test("an UpdateError without a stage adopts the fallback stage", () => {
  assert.deepEqual(describeUpdateFailure(new UpdateError("NOT_DOWNLOADED"), "install"), {
    code: "NOT_DOWNLOADED",
    stage: "install",
  });
});

test("unknown failures collapse to UPDATE_FAILED and never echo a message", () => {
  assert.deepEqual(describeUpdateFailure(new Error("EACCES /Users/me/secret"), "prepare"), {
    code: "UPDATE_FAILED",
    stage: "prepare",
  });
  assert.deepEqual(describeUpdateFailure(undefined, "install"), {
    code: "UPDATE_FAILED",
    stage: "install",
  });
  assert.deepEqual(
    describeUpdateFailure({ code: "/Users/me/secret" }, "check"),
    { code: "UPDATE_FAILED", stage: "check" },
  );
});

test("safe errno codes survive with the fallback stage", () => {
  assert.deepEqual(
    describeUpdateFailure(Object.assign(new Error("x"), { code: "EACCES" }), "download"),
    { code: "EACCES", stage: "download" },
  );
});

test("a previous failure code can never be reused for a later failure", () => {
  const first = describeUpdateFailure(
    Object.assign(new Error("x"), { code: "EACCES" }),
    "download",
  );
  const second = describeUpdateFailure(new Error("boom"), "install");
  assert.deepEqual(first, { code: "EACCES", stage: "download" });
  assert.deepEqual(second, { code: "UPDATE_FAILED", stage: "install" });
});
