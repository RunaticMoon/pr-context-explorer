import test from "node:test";
import assert from "node:assert/strict";
import { installPublicUpdate } from "../desktop/public-update-host.ts";
test("native denial never locks or prepares; busy never cancels analyses", async () => {
  const calls: string[] = [];
  const hooks = {
    version: () => "9.0.0",
    confirm: async () => false,
    lock: async () => {
      calls.push("lock");
      return false;
    },
    unlock: async () => {
      calls.push("unlock");
    },
    prepare: async () => {
      calls.push("prepare");
    },
    quit: async () => {
      calls.push("quit");
    },
  };
  assert.equal(await installPublicUpdate(hooks), "DECLINED");
  assert.deepEqual(calls, []);
  hooks.confirm = async () => true;
  assert.equal(await installPublicUpdate(hooks), "BUSY");
  assert.deepEqual(calls, ["lock", "unlock"]);
});
test("helper readiness precedes quit; failed preparation reopens admission", async () => {
  const calls: string[] = [];
  const hooks = {
    version: () => "9.0.0",
    confirm: async (v: string) => {
      assert.equal(v, "9.0.0");
      return true;
    },
    lock: async () => {
      calls.push("lock");
      return true;
    },
    unlock: async () => {
      calls.push("unlock");
    },
    prepare: async () => {
      calls.push("ready");
    },
    quit: async () => {
      calls.push("quit");
    },
  };
  assert.equal(await installPublicUpdate(hooks), "READY");
  assert.deepEqual(calls, ["lock", "ready", "quit"]);
  calls.length = 0;
  hooks.prepare = async () => {
    throw Error("failure");
  };
  await assert.rejects(installPublicUpdate(hooks), /failure/);
  assert.deepEqual(calls, ["lock", "unlock"]);
});
