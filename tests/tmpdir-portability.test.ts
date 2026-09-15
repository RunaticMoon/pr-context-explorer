import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Reproduce macOS /tmp -> /private/tmp on any supported POSIX test host.
// Run the actual fixture setup and its existing malicious-symlink assertions;
// resolving arbitrary caller-supplied store/settings paths is NOT the fix.
test("store, settings and desktop fixtures work beneath an aliased system temp directory", (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-tmp-alias-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alias = path.join(root, "tmp-alias");
  symlinkSync(root, alias, "dir");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: alias,
    TMP: alias,
    TEMP: alias,
  };
  // A nested Node test runner must not inherit its parent's worker context.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "tests/store.test.ts",
      "tests/settings.test.ts",
      "tests/desktop-runtime.test.ts",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
