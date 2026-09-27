import test from "node:test";
import assert from "node:assert/strict";
import {
  UpdateError,
  UPDATE_ERROR_STAGES,
  errorCode,
} from "../desktop/public-update/policy.ts";

test("UpdateError keeps the legacy single-argument form", () => {
  const e = new UpdateError("HASH_MISMATCH");
  assert.equal(e.code, "HASH_MISMATCH");
  assert.equal(e.errorStage, undefined);
  assert.equal(e.message, "HASH_MISMATCH");
});

test("UpdateError carries an optional stage", () => {
  const e = new UpdateError("NETWORK", "download");
  assert.equal(e.errorStage, "download");
  assert.deepEqual(
    [...UPDATE_ERROR_STAGES],
    ["check", "download", "prepare", "install", "cancel", "preferences"],
  );
});

test("errorCode preserves safe errno codes and rejects everything else", () => {
  assert.equal(errorCode(Object.assign(new Error("x"), { code: "EACCES" }), "F"), "EACCES");
  assert.equal(errorCode(new UpdateError("UNSAFE_DNS"), "F"), "UNSAFE_DNS");
  assert.equal(errorCode({ code: 1 }, "F"), "F");
  assert.equal(errorCode({ code: "enoent" }, "F"), "F");
  assert.equal(errorCode({ code: "/Users/me/secret" }, "F"), "F");
  assert.equal(errorCode({ code: "A".repeat(40) }, "F"), "F");
  assert.equal(errorCode(new Error("EACCES /Users/me"), "F"), "F");
  assert.equal(errorCode(null, "F"), "F");
});
