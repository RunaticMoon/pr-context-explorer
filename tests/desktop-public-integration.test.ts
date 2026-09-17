import test from "node:test";
import assert from "node:assert/strict";
import { validUpdateCommand } from "../desktop/security.ts";
import { LiveAPI } from "../src/server/live-api.ts";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("update commands have finite exact shapes, never paths or coercion", () => {
  for (const action of ["check", "download", "cancel", "install"]) {
    assert.equal(validUpdateCommand({ action }), true);
    assert.equal(
      validUpdateCommand({ action, url: "https://evil.example" }),
      false,
    );
  }
  assert.equal(
    validUpdateCommand({
      action: "preferences",
      autoCheck: true,
      autoDownload: false,
    }),
    true,
  );
  for (const value of [
    null,
    [],
    { action: "shell" },
    { action: "preferences", autoCheck: 1, autoDownload: false },
    { action: "preferences", autoCheck: true, autoDownload: false, token: "x" },
  ])
    assert.equal(validUpdateCommand(value), false);
});
test("admission closes atomically, refuses active work without cancellation", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "admission-")));
  let live: LiveAPI | undefined;
  try {
    live = new LiveAPI({ dataDir: dir });
    assert.equal(live.lockDesktopAdmission(), true);
    assert.throws(
      () => (live as any).start("snapshot", async () => {}),
      /admission/,
    );
    live.unlockDesktopAdmission();
    let done!: () => void;
    (live as any).start(
      "snapshot",
      () =>
        new Promise<void>((r) => {
          done = r;
        }),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(live.lockDesktopAdmission(), false);
    assert.equal([...live.jobs.values()][0].controller.signal.aborted, false);
    done();
    await new Promise((r) => setImmediate(r));
    assert.equal(live.lockDesktopAdmission(), true);
  } finally {
    live?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
