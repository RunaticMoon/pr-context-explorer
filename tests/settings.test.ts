import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("AI settings are loaded only from an explicit private server file; no browser paths or ambient auth", async () => {
  const { readServerSettings } = await import("../src/server/settings.ts");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "prce-settings-")));
  const file = path.join(root, "ai.json");
  try {
    assert.deepEqual(readServerSettings(undefined), {});
    writeFileSync(
      file,
      JSON.stringify({
        providers: {
          codex: {
            auth: {
              kind: "codex-auth-file",
              path: "/approved/explicit/auth.json",
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    assert.ok(readServerSettings(file).providers);
    chmodSync(file, 0o644);
    assert.throws(() => readServerSettings(file), /private/);
    chmodSync(file, 0o600);
    symlinkSync(file, path.join(root, "link"));
    assert.throws(() => readServerSettings(path.join(root, "link")), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
