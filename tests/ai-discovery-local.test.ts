import { test } from "node:test";
import assert from "node:assert/strict";
import { engineCandidates } from "../src/server/ai/discovery.ts";
test("fixed candidates use actual host home and never ambient PATH or shell", () => {
  const paths = engineCandidates("codex", "/app", "/host", "linux", "x64");
  assert.ok(paths.includes("/host/.local/bin/codex"));
  assert.ok(paths.some((p) => p.includes("@openai/codex-linux-x64")));
  assert.ok(paths.every((p) => p.startsWith("/") && !p.includes("$")));
  assert.deepEqual(
    engineCandidates("claude", "/app", "/host", "win32", "x64"),
    [],
  );
  assert.deepEqual(
    engineCandidates("codex", "/app/", "/host", "linux", "x64"),
    paths,
  );
});
