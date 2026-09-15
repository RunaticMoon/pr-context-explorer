import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  symlink,
  chmod,
} from "node:fs/promises";
import { prepareAuth } from "../src/server/ai/auth.ts";

test("engine auth reads only an explicit private path and never inherits service env", async () => {
  const dir = await realpath(await mkdtemp("/tmp/ai-auth-test-"));
  try {
    await writeFile(`${dir}/key`, "FAKE_API_KEY", { mode: 0o600 });
    const auth = await prepareAuth(
      "claude",
      { kind: "api-key-file", path: `${dir}/key` },
      dir,
    );
    assert.deepEqual(auth.env, { ANTHROPIC_API_KEY: "FAKE_API_KEY" });
    assert.deepEqual(auth.files, []);
    assert.equal(auth.mode, "api-key");
    await chmod(`${dir}/key`, 0o644);
    await assert.rejects(
      prepareAuth("claude", { kind: "api-key-file", path: `${dir}/key` }, dir),
      { code: "auth_invalid" },
    );
    await symlink(`${dir}/key`, `${dir}/link`);
    await assert.rejects(
      prepareAuth("claude", { kind: "api-key-file", path: `${dir}/link` }, dir),
      { code: "auth_invalid" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Codex copies only credential fields, never config/MCP/prompt fields", async () => {
  const dir = await realpath(await mkdtemp("/tmp/ai-auth-test-"));
  try {
    const source = `${dir}/supplied-auth.json`;
    const original = {
      auth_mode: "chatgpt",
      tokens: {
        access_token: "FAKE_ACCESS",
        refresh_token: "FAKE_REFRESH",
        id_token: "FAKE_ID",
        account_id: "FAKE_ACCOUNT",
        malicious: "omit",
      },
      last_refresh: "2026-01-01T00:00:00Z",
      mcp_servers: { evil: {} },
      instructions: "BAD",
    };
    await writeFile(source, JSON.stringify(original), { mode: 0o600 });
    const auth = await prepareAuth(
      "codex",
      { kind: "codex-auth-file", path: source },
      dir,
    );
    assert.deepEqual(auth.env, {});
    assert.equal(auth.files.length, 1);
    const copy = JSON.parse(await readFile(auth.files[0].source, "utf8"));
    assert.equal(copy.instructions, undefined);
    assert.equal(copy.mcp_servers, undefined);
    assert.equal(copy.tokens.malicious, undefined);
    assert.equal(copy.tokens.access_token, "FAKE_ACCESS");
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
for (const mode of [
  "UNSUPPORTED_REVIEW_MODE",
  "",
  "ChatGPT",
  null,
  false,
  {},
  [],
  undefined,
]) {
  test(`Codex rejects unsupported or absent auth_mode (${JSON.stringify(mode)}) without writing a repaired identity`, async () => {
    const dir = await realpath(await mkdtemp("/tmp/ai-auth-mode-"));
    try {
      const source = `${dir}/supplied-auth.json`;
      const bytes = JSON.stringify({
        auth_mode: mode,
        tokens: {
          access_token: "SYNTHETIC_ACCESS",
          refresh_token: "SYNTHETIC_REFRESH",
          id_token: "SYNTHETIC_ID",
          account_id: "SYNTHETIC_ACCOUNT",
        },
      });
      await writeFile(source, bytes, { mode: 0o600 });
      await assert.rejects(
        prepareAuth("codex", { kind: "codex-auth-file", path: source }, dir),
        { code: "auth_invalid" },
      );
      assert.ok(
        (await readFile(source, "utf8")) === bytes,
        "canonical input remains unchanged",
      );
      await assert.rejects(readFile(`${dir}/engine-auth.json`), {
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
test("Codex supported discriminators require their own complete token shape", async () => {
  const dir = await realpath(await mkdtemp("/tmp/ai-auth-shape-"));
  try {
    const source = `${dir}/source.json`;
    const tokens = {
      access_token: "SYNTHETIC_ACCESS",
      refresh_token: "SYNTHETIC_REFRESH",
      id_token: "SYNTHETIC_ID",
      account_id: "SYNTHETIC_ACCOUNT",
    };
    for (const input of [
      { auth_mode: "apikey", tokens },
      { auth_mode: "chatgpt", OPENAI_API_KEY: "SYNTHETIC_KEY" },
      ...Object.keys(tokens).map((key) => ({
        auth_mode: "chatgpt",
        tokens: { ...tokens, [key]: null },
      })),
    ]) {
      await writeFile(source, JSON.stringify(input), { mode: 0o600 });
      await assert.rejects(
        prepareAuth("codex", { kind: "codex-auth-file", path: source }, dir),
        { code: "auth_invalid" },
      );
    }
    await writeFile(
      source,
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "SYNTHETIC_KEY",
        tokens: null,
      }),
      { mode: 0o600 },
    );
    const prepared = await prepareAuth(
      "codex",
      { kind: "codex-auth-file", path: source },
      dir,
    );
    const copied = JSON.parse(await readFile(prepared.files[0].source, "utf8"));
    assert.equal(copied.auth_mode, "apikey");
    assert.ok(copied.OPENAI_API_KEY === "SYNTHETIC_KEY");
    assert.equal(copied.tokens, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical private auth succeeds but a user-controlled parent alias stays rejected", async () => {
  const dir = await realpath(await mkdtemp("/tmp/ai-auth-parent-"));
  const alias = `${dir}-alias`;
  try {
    await writeFile(`${dir}/key`, "FAKE_PRIVATE_KEY", { mode: 0o600 });
    await symlink(dir, alias);
    await assert.rejects(
      prepareAuth("codex", { kind: "api-key-file", path: `${alias}/key` }, dir),
      { code: "auth_invalid" },
    );
    const prepared = await prepareAuth(
      "codex",
      { kind: "api-key-file", path: `${dir}/key` },
      dir,
    );
    assert.deepEqual(prepared.env, { CODEX_API_KEY: "FAKE_PRIVATE_KEY" });
  } finally {
    await rm(alias, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing or cross-provider auth is not reported authenticated", async () => {
  await assert.rejects(prepareAuth("codex", undefined, "/tmp"), {
    code: "auth_required",
  });
  await assert.rejects(
    prepareAuth(
      "codex",
      { kind: "claude-oauth-token-file", path: "/not-read" },
      "/tmp",
    ),
    { code: "auth_invalid" },
  );
});
