import "./public-update-test-support.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writePrivate, readPrivate } from "../desktop/public-update/files.ts";
import { validateACLResponse } from "../desktop/public-update/acl.ts";
test("native ACL wire protocol rejects grants, warnings and ambiguous output", () => {
  for (const s of [
    '{"version":1,"status":"empty"}\n',
    '{"version":1,"status":"deny-only"}\n',
  ])
    assert.doesNotThrow(() => validateACLResponse(s, ""));
  for (const s of [
    "",
    '{"version":1,"status":"allow"}\n',
    '{"version":1,"status":"empty"}',
    '{"version":1,"status":"empty","extra":1}\n',
  ])
    assert.throws(() => validateACLResponse(s, ""));
  assert.throws(() =>
    validateACLResponse('{"version":1,"status":"empty"}\n', "warning"),
  );
});
test("private receipt publication is no-replace and never exposes partial JSON", async () => {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "public-receipt-"),
  );
  try {
    const file = path.join(root, "receipt.json");
    const value = { nonce: "a".repeat(64), payload: "x".repeat(20000) };
    const writing = writePrivate(file, value);
    while (!(await lstat(file).catch(() => null)))
      await new Promise((r) => setTimeout(r, 1));
    assert.deepEqual(await readPrivate(file), value);
    await writing;
    await assert.rejects(writePrivate(file, { overwritten: true }));
    assert.deepEqual(await readPrivate(file), value);
    const sentinel = path.join(root, "sentinel");
    await writeFile(sentinel, "old");
    await assert.rejects(writePrivate(sentinel, { bad: true }));
    assert.equal(await readFile(sentinel, "utf8"), "old");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
