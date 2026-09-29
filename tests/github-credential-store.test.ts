import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createGitHubCredentialStore,
  type SecurityRunner,
} from "../src/server/github-credential-store.ts";

const SERVICE = "PR Context Explorer GitHub PAT";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function tempRoot(): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), "prce-credential-")));
}

test("file backend round-trips a PAT in a private 0600 file", async () => {
  const root = tempRoot();
  const dataDir = path.join(root, "nested", "creds");
  try {
    const store = createGitHubCredentialStore({
      dataDir,
      backend: "file",
      platform: "linux",
    });
    assert.equal(store.backend, "file");
    assert.equal(await store.load("conn1"), null);
    assert.equal(await store.save("conn1", "ghp_token1"), true);
    assert.equal(await store.load("conn1"), "ghp_token1");
    const file = path.join(dataDir, "github-credentials.json");
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dataDir).mode & 0o077, 0);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
      version: 1,
      tokens: { conn1: "ghp_token1" },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend merges multiple connections", async () => {
  const root = tempRoot();
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    assert.equal(await store.save("connA", "token-a"), true);
    assert.equal(await store.save("connB", "token-b"), true);
    assert.equal(await store.load("connA"), "token-a");
    assert.equal(await store.load("connB"), "token-b");
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(root, "github-credentials.json"), "utf8"),
      ),
      { version: 1, tokens: { connA: "token-a", connB: "token-b" } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend deletes one connection and removes the file with the last", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await store.save("connA", "token-a");
    await store.save("connB", "token-b");
    await store.delete("connA");
    assert.equal(await store.load("connA"), null);
    assert.equal(await store.load("connB"), "token-b");
    assert.ok(existsSync(file));
    await store.delete("connB");
    assert.equal(await store.load("connB"), null);
    assert.equal(existsSync(file), false);
    // Deleting a missing key is a no-op.
    await store.delete("connB");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend refuses to read a world-readable file", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await store.save("conn1", "ghp_token1");
    chmodSync(file, 0o644);
    assert.equal(await store.load("conn1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend refuses a symlinked credential file", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  const outside = path.join(root, "outside.json");
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await store.save("conn1", "ghp_token1");
    writeFileSync(
      outside,
      JSON.stringify({ version: 1, tokens: { conn1: "attacker" } }),
      { mode: 0o600 },
    );
    unlinkSync(file);
    symlinkSync(outside, file);
    assert.equal(await store.load("conn1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend rejects invalid connection ids and tokens", async () => {
  const root = tempRoot();
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    assert.equal(await store.save("bad id", "token"), false);
    assert.equal(await store.save("bad/id", "token"), false);
    assert.equal(await store.save("", "token"), false);
    assert.equal(await store.save("a".repeat(65), "token"), false);
    assert.equal(await store.save("ok", ""), false);
    assert.equal(await store.save("ok", "has space"), false);
    assert.equal(await store.save("ok", "a\nb"), false);
    assert.equal(await store.save("ok", "nul\u0000char"), false);
    assert.equal(await store.save("ok", "a".repeat(8193)), false);
    assert.equal(await (store.save as any)("ok", 123), false);
    assert.equal(await store.load("bad id"), null);
    await store.delete("bad id");
    // Boundaries are accepted.
    assert.equal(await store.save("a".repeat(64), "ok"), true);
    assert.equal(await store.save("x", "y".repeat(8192)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend treats corrupt or malformed JSON as empty", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    mkdirSync(root, { recursive: true });
    writeFileSync(file, "{not json", { mode: 0o600 });
    assert.equal(await store.load("conn1"), null);
    writeFileSync(
      file,
      JSON.stringify({ version: 2, tokens: { conn1: "t" } }),
      {
        mode: 0o600,
      },
    );
    assert.equal(await store.load("conn1"), null);
    writeFileSync(file, JSON.stringify([1, 2, 3]), { mode: 0o600 });
    assert.equal(await store.load("conn1"), null);
    writeFileSync(file, JSON.stringify({ version: 1, tokens: "nope" }), {
      mode: 0o600,
    });
    assert.equal(await store.load("conn1"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend cleans up its plaintext temp file when the write fails", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    // A directory at the destination makes the final rename fail.
    mkdirSync(file, { recursive: true });
    writeFileSync(path.join(file, "keep"), "1");
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    assert.equal(await store.save("conn1", "ghp_token1"), false);
    assert.equal(statSync(file).isDirectory(), true);
    assert.deepEqual(
      readdirSync(root).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend removes stale temp files without following symlinks", async () => {
  const root = tempRoot();
  const stale = path.join(root, ".github-credentials.deadbeef.tmp");
  const link = path.join(root, ".github-credentials.cafe.tmp");
  const target = path.join(root, "target.txt");
  try {
    writeFileSync(target, "keep");
    writeFileSync(stale, "ghp_plaintext", { mode: 0o600 });
    symlinkSync(target, link);
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    assert.equal(await store.save("conn1", "ghp_token1"), true);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(link), false);
    assert.equal(readFileSync(target, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend deletes a credential file it cannot trust", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await store.save("conn1", "ghp_token1");
    chmodSync(file, 0o644);
    await store.delete("conn1");
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend deletes a corrupt credential file", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    writeFileSync(file, "{not json", { mode: 0o600 });
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await store.delete("conn1");
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend deletes a symlinked credential file without touching its target", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  const outside = path.join(root, "outside.json");
  try {
    writeFileSync(outside, "keep", { mode: 0o600 });
    symlinkSync(outside, file);
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await store.delete("conn1");
    assert.equal(existsSync(file), false);
    assert.equal(readFileSync(outside, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend reports a delete that cannot complete", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    mkdirSync(file, { recursive: true });
    writeFileSync(path.join(file, "keep"), "1");
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    await assert.rejects(store.delete("conn1"), /credential delete failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("file backend refuses to overwrite or remove an unreadable entry", async () => {
  const root = tempRoot();
  const file = path.join(root, "github-credentials.json");
  try {
    mkdirSync(file, { recursive: true });
    writeFileSync(path.join(file, "marker"), "keep");
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "file",
    });
    assert.equal(await store.save("conn1", "ghp_token1"), false);
    assert.equal(statSync(file).isDirectory(), true);
    assert.deepEqual(readdirSync(file), ["marker"]);
    await assert.rejects(store.delete("conn1"), /credential delete failed/);
    assert.equal(existsSync(file), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "file backend leaves credentials untouched when the file cannot be read",
  { skip: isRoot ? "requires a non-root user (EACCES)" : false },
  async () => {
    const root = tempRoot();
    const file = path.join(root, "github-credentials.json");
    try {
      const original = JSON.stringify({
        version: 1,
        tokens: { conn1: "keep-me" },
      });
      writeFileSync(file, original, { mode: 0o600 });
      chmodSync(file, 0o000);
      const store = createGitHubCredentialStore({
        dataDir: root,
        backend: "file",
      });
      // A transient read error must not be mistaken for "empty".
      assert.equal(await store.load("conn1"), null);
      assert.equal(await store.save("conn2", "new-token"), false);
      await assert.rejects(store.delete("conn1"), /credential delete failed/);
      assert.equal(existsSync(file), true);
      assert.deepEqual(
        readdirSync(root).filter((name) => name.endsWith(".tmp")),
        [],
      );
      chmodSync(file, 0o600);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), {
        version: 1,
        tokens: { conn1: "keep-me" },
      });
    } finally {
      try {
        chmodSync(file, 0o600);
      } catch {
        // Best effort before cleanup.
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "file backend does not block on a FIFO credential path",
  { timeout: 5000 },
  async (t) => {
    const root = tempRoot();
    const file = path.join(root, "github-credentials.json");
    const makeFifo = (): boolean => {
      try {
        execFileSync("mkfifo", [file]);
        return true;
      } catch {
        return false;
      }
    };
    try {
      if (!makeFifo()) {
        t.skip("mkfifo unavailable");
        return;
      }
      const store = createGitHubCredentialStore({
        dataDir: root,
        backend: "file",
      });
      // A blocking open would hang here and trip the test timeout.
      assert.equal(await store.load("conn1"), null);
      // untrusted rules still apply: delete removes the special file.
      await store.delete("conn1");
      assert.equal(existsSync(file), false);
      // save replaces an untrusted entry with a private regular file.
      if (!makeFifo()) {
        t.skip("mkfifo unavailable");
        return;
      }
      assert.equal(await store.save("conn1", "ghp_token1"), true);
      assert.equal(statSync(file).isFile(), true);
      assert.equal(await store.load("conn1"), "ghp_token1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("off backend never persists anything", async () => {
  const root = tempRoot();
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "off",
    });
    assert.equal(store.backend, "off");
    assert.equal(await store.load("conn1"), null);
    assert.equal(await store.save("conn1", "ghp_token1"), false);
    await store.delete("conn1");
    assert.equal(existsSync(path.join(root, "github-credentials.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend keeps the token out of argv and speaks to `security -i`", async () => {
  const root = tempRoot();
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const runner: SecurityRunner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "find-generic-password")
      return { code: 0, stdout: "ghp_keychain_token\n" };
    return { code: 0, stdout: "" };
  };
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "keychain",
      runSecurity: runner,
    });
    assert.equal(store.backend, "keychain");

    assert.equal(await store.load("conn-1"), "ghp_keychain_token");
    assert.deepEqual(calls[0].args, [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      "conn-1",
      "-w",
    ]);
    assert.equal(calls[0].stdin, undefined);

    assert.equal(await store.save("conn-1", "secret-token"), true);
    const save = calls[1];
    assert.equal(save.args[0], "-i");
    assert.equal(save.args.includes("secret-token"), false);
    assert.equal(JSON.stringify(save.args).includes("secret-token"), false);
    assert.ok(
      save.stdin?.includes(
        `add-generic-password -U -s "${SERVICE}" -a "conn-1" -w "secret-token"`,
      ),
    );
    assert.ok(save.stdin?.endsWith("\n"));

    await store.delete("conn-1");
    assert.deepEqual(calls[2].args, [
      "delete-generic-password",
      "-s",
      SERVICE,
      "-a",
      "conn-1",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend treats missing entries and failures as absent", async () => {
  const root = tempRoot();
  try {
    const missing = createGitHubCredentialStore({
      dataDir: root,
      backend: "keychain",
      runSecurity: async () => ({ code: 44, stdout: "" }),
    });
    assert.equal(await missing.load("conn1"), null);
    assert.equal(await missing.save("conn1", "token"), false);

    const boom = createGitHubCredentialStore({
      dataDir: root,
      backend: "keychain",
      runSecurity: async () => {
        throw Error("no keychain available");
      },
    });
    assert.equal(await boom.load("conn1"), null);
    assert.equal(await boom.save("conn1", "token"), false);
    await assert.rejects(boom.delete("conn1"), /credential delete failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend reports delete outcomes without leaking a token", async () => {
  const root = tempRoot();
  const run =
    (code: number): SecurityRunner =>
    async () => ({ code, stdout: "" });
  try {
    const gone = createGitHubCredentialStore({
      dataDir: root,
      backend: "keychain",
      runSecurity: run(44),
    });
    await gone.delete("conn1");

    const failed = createGitHubCredentialStore({
      dataDir: root,
      backend: "keychain",
      runSecurity: run(1),
    });
    await assert.rejects(failed.delete("conn1"), (error: Error) => {
      assert.equal(error.message, "credential delete failed");
      assert.equal(error.message.includes("token"), false);
      return true;
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keychain backend refuses tokens that would break the interactive command", async () => {
  const root = tempRoot();
  let called = 0;
  const runner: SecurityRunner = async () => {
    called += 1;
    return { code: 0, stdout: "" };
  };
  try {
    const store = createGitHubCredentialStore({
      dataDir: root,
      backend: "keychain",
      runSecurity: runner,
    });
    assert.equal(await store.save("conn1", 'a"b'), false);
    assert.equal(await store.save("conn1", "a'b"), false);
    assert.equal(await store.save("conn1", "a\\b"), false);
    assert.equal(called, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backend selection prefers option, then env, then platform", () => {
  const root = tempRoot();
  const original = process.env.PRCE_GITHUB_CREDENTIAL_STORE;
  const select = (options: Parameters<typeof createGitHubCredentialStore>[0]) =>
    createGitHubCredentialStore(options).backend;
  try {
    process.env.PRCE_GITHUB_CREDENTIAL_STORE = "off";
    assert.equal(select({ dataDir: root, platform: "darwin" }), "off");
    process.env.PRCE_GITHUB_CREDENTIAL_STORE = "keychain";
    assert.equal(select({ dataDir: root, platform: "linux" }), "keychain");
    process.env.PRCE_GITHUB_CREDENTIAL_STORE = "file";
    assert.equal(select({ dataDir: root, platform: "darwin" }), "file");
    // Unknown env values are ignored in favour of the platform default.
    process.env.PRCE_GITHUB_CREDENTIAL_STORE = "bogus";
    assert.equal(select({ dataDir: root, platform: "darwin" }), "keychain");
    delete process.env.PRCE_GITHUB_CREDENTIAL_STORE;
    assert.equal(select({ dataDir: root, platform: "darwin" }), "keychain");
    assert.equal(select({ dataDir: root, platform: "linux" }), "file");
    // The explicit option wins over the environment.
    process.env.PRCE_GITHUB_CREDENTIAL_STORE = "off";
    assert.equal(
      select({ dataDir: root, backend: "file", platform: "darwin" }),
      "file",
    );
  } finally {
    if (original === undefined) delete process.env.PRCE_GITHUB_CREDENTIAL_STORE;
    else process.env.PRCE_GITHUB_CREDENTIAL_STORE = original;
    rmSync(root, { recursive: true, force: true });
  }
});
