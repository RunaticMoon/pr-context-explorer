import test from "node:test";
import assert from "node:assert/strict";
import { installPublicUpdate } from "../desktop/public-update-host.ts";
import { UpdateError } from "../desktop/public-update/policy.ts";
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
  await assert.rejects(
    installPublicUpdate(hooks),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "UPDATE_FAILED" &&
      e.errorStage === "prepare",
  );
  assert.deepEqual(calls, ["lock", "unlock"]);
});
test("prepare failures keep their bounded code and prepare stage", async () => {
  const calls: string[] = [];
  const hooks = {
    version: () => "9.0.0",
    confirm: async () => true,
    lock: async () => {
      calls.push("lock");
      return true;
    },
    unlock: async () => {
      calls.push("unlock");
    },
    prepare: async () => {
      calls.push("prepare");
      throw new UpdateError("HASH_MISMATCH", "prepare");
    },
    quit: async () => {
      calls.push("quit");
    },
  };
  await assert.rejects(
    installPublicUpdate(hooks),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "HASH_MISMATCH" &&
      e.errorStage === "prepare",
  );
  assert.deepEqual(calls, ["lock", "prepare", "unlock"]);
});
test("a failing unlock never masks the primary failure", async () => {
  const calls: string[] = [];
  const hooks = {
    version: () => "9.0.0",
    confirm: async () => true,
    lock: async () => {
      calls.push("lock");
      return true;
    },
    unlock: async () => {
      calls.push("unlock");
      throw new UpdateError("UNLOCK_FAILED", "install");
    },
    prepare: async () => {
      calls.push("prepare");
      throw new UpdateError("HASH_MISMATCH", "prepare");
    },
    quit: async () => {
      calls.push("quit");
    },
  };
  await assert.rejects(
    installPublicUpdate(hooks),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "HASH_MISMATCH" &&
      e.errorStage === "prepare",
  );
  assert.deepEqual(calls, ["lock", "prepare", "unlock"]);
});
test("a lone unlock failure still surfaces", async () => {
  const hooks = {
    version: () => "9.0.0",
    confirm: async () => true,
    lock: async () => false,
    unlock: async () => {
      throw new UpdateError("UNLOCK_FAILED", "install");
    },
    prepare: async () => {},
    quit: async () => {},
  };
  await assert.rejects(
    installPublicUpdate(hooks),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "UNLOCK_FAILED" &&
      e.errorStage === "install",
  );
});
test("host-side failures are tagged with the install stage", async () => {
  const base = {
    version: () => "9.0.0",
    confirm: async () => true,
    lock: async () => true,
    unlock: async () => {},
    prepare: async () => {},
    quit: async () => {},
  };
  await assert.rejects(
    installPublicUpdate({
      ...base,
      version: () => undefined,
      confirm: async () => true,
    }),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "NOT_DOWNLOADED" &&
      e.errorStage === "install",
  );
  let versions = 0;
  await assert.rejects(
    installPublicUpdate({
      ...base,
      version: () => (versions++ === 0 ? "9.0.0" : "9.0.1"),
      confirm: async () => true,
    }),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "UPDATE_CHANGED" &&
      e.errorStage === "install",
  );
  await assert.rejects(
    installPublicUpdate({
      ...base,
      lock: async () => {
        throw Error("lock exploded");
      },
    }),
    (e: unknown) =>
      e instanceof UpdateError &&
      e.code === "UPDATE_FAILED" &&
      e.errorStage === "install" &&
      !e.message.includes("exploded"),
  );
});
