import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
test("Git retention removes only expired app-owned bare directories", async () => {
  const { pruneGitCache } = await import("../src/server/ingest.ts");
  const { mkdirSync, utimesSync, existsSync } = await import("node:fs");
  const root = mkdtempSync(path.join(tmpdir(), "prce-retention-"));
  try {
    const dir = path.join(root, "git", "a".repeat(64));
    mkdirSync(dir, { recursive: true });
    const marker = path.join(dir, "prce-owned");
    writeFileSync(marker, "PRCE app-only bare cache v1\n");
    utimesSync(marker, 1, 1);
    const unrelated = path.join(root, "git", "keep");
    mkdirSync(unrelated);
    assert.equal(pruneGitCache(root, 1000, 5000), 1);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(unrelated), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private durable JSON store, scoped cache identity, stale/retention/delete and symlink rejection", async () => {
  const { LocalStore, cacheKey } = await import("../src/server/store.ts");
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-store-test-")),
  );
  try {
    const store = new LocalStore(path.join(root, "data"), 1000);
    const dimensions = {
      host: "a",
      account: "alice",
      repository: "a/r",
      pr: 1,
      base: "b",
      head: "h",
      prBody: "text",
      jira: ["hash"],
      scope: "pr",
      provider: "codex",
      model: "m",
      prompt: "p",
      schema: "1",
      parser: "ts",
    };
    const key = cacheKey(dimensions);
    store.put("analysis", key, { text: "private code" }, 100);
    assert.deepEqual(
      new LocalStore(path.join(root, "data"), 1000).get("analysis", key, 101),
      { text: "private code" },
    );
    assert.equal(statSync(path.join(root, "data")).mode & 0o777, 0o700);
    assert.equal(
      statSync(path.join(root, "data", "analysis", key + ".json")).mode & 0o777,
      0o600,
    );
    for (const field of Object.keys(dimensions))
      assert.notEqual(
        cacheKey({ ...dimensions, [field]: "changed" }),
        key,
        field,
      );
    assert.equal(store.get("analysis", key, 1101), null);
    store.put("analysis", key, { text: "x" }, 100);
    assert.equal(store.prune(1101), 1);
    store.put("analysis", key, { text: "x" });
    store.delete("analysis", key);
    assert.equal(store.get("analysis", key), null);
    assert.throws(() => store.put("analysis", "../escape", {}));
    const victim = path.join(root, "victim");
    writeFileSync(victim, "DO NOT READ");
    symlinkSync(victim, path.join(root, "data", "analysis", key + ".json"));
    assert.throws(() => store.get("analysis", key));
    symlinkSync(root, path.join(root, "link"));
    assert.throws(() => new LocalStore(path.join(root, "link", "data")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
