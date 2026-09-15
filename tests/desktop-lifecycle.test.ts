import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as lifecycle from "../desktop/lifecycle.ts";
test("backend lifecycle boots once, queries bounded IPC, gracefully stops and reaps child (test worker, not Electron)", async () => {
  assert.equal(typeof lifecycle.BackendProcess, "function");
  const root = mkdtempSync(path.join(tmpdir(), "prce-lifecycle-"));
  const entry = path.join(root, "worker.cjs");
  writeFileSync(
    entry,
    `process.on('message',m=>{if(m.type==='start')process.send({type:'ready',origin:'http://127.0.0.1:12345'});if(m.type==='status')process.send({type:'status',id:m.id,active:false});if(m.type==='shutdown')process.exit(0)});`,
  );
  const backend = new lifecycle.BackendProcess({
    node: process.execPath,
    entry,
    runtime: root,
    data: root,
    dist: root,
  });
  try {
    assert.equal(await backend.start(), "http://127.0.0.1:12345");
    await assert.rejects(() => backend.start());
    assert.equal(await backend.active(), false);
    const pid = backend.pid!;
    await backend.stop();
    await backend.stop();
    assert.throws(() => process.kill(pid, 0));
    assert.equal(await backend.active(), true);
  } finally {
    await backend.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
