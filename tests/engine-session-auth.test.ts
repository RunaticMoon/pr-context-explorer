import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { createEngineSetupService } from "../src/server/engine-setup.ts";
import { prepareAuth } from "../src/server/ai/auth.ts";
import { LiveAPI } from "../src/server/live-api.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseAuthStatus } from "../src/server/ai/cli.ts";

test(
  "FAKE native status executable receives only prepared OAuth env, with real fingerprint and no inference",
  { skip: process.platform !== "linux" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "session-native-"));
    writeFileSync(
      join(root, "fake.c"),
      `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(int argc,char **argv){if(argc!=3||strcmp(argv[1],"auth")||strcmp(argv[2],"status"))return 8;if(getenv("ANTHROPIC_API_KEY")||getenv("GH_TOKEN"))return 9;char *t=getenv("CLAUDE_CODE_OAUTH_TOKEN");puts(t?"{\\"loggedIn\\":true}":"{\\"loggedIn\\":false}");return t?0:1;}`,
    );
    const binary = join(root, "claude");
    execFileSync("/usr/bin/cc", [join(root, "fake.c"), "-o", binary]);
    chmodSync(binary, 0o700);
    let statusCalls = 0;
    const template = fixture();
    const initial = (await template.service.status()).engines[0];
    template.service.close();
    const service = createEngineSetupService(
      {},
      {
        scratchRoot: root,
        resolve: async () => binary,
        probe: async (config, _signal, validate) => {
          const auth = config?.providers?.claude?.auth;
          let status:
            | "authenticated"
            | "not_configured"
            | "not_authenticated"
            | "unknown" = "not_configured";
          if (auth) {
            await validate!("claude", binary);
            const prepared = await prepareAuth("claude", auth, root);
            const output = execFileSync(binary, ["auth", "status"], {
              env: prepared.env,
              encoding: "utf8",
            });
            statusCalls++;
            status = parseAuthStatus("claude", 0, output, "");
          }
          return [
            {
              ...initial,
              authentication: { ...initial.authentication, status },
              ready: status === "authenticated",
            },
          ];
        },
      },
    );
    try {
      const id = (await service.status()).engines[0].candidateId!;
      const result = await service.setSessionAuth("claude", id, token);
      assert.equal(result.engines[0].ready, true);
      assert.equal(result.engines[0].inferenceVerified, false);
      assert.equal(statusCalls, 1);
      assert.ok(!JSON.stringify(result).includes(token));
    } finally {
      service.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("session auth API uses exact shapes, generic errors and rejects active-job changes", async () => {
  const { service } = fixture();
  const root = mkdtempSync(join(tmpdir(), "session-api-"));
  const api = new LiveAPI({ dataDir: root, engineSetup: service });
  const url = new URL("http://localhost/api/engines/setup");
  try {
    const candidateId = (await service.status()).engines[0].candidateId!;
    const body = {
      action: "set-session-auth",
      providerId: "claude",
      candidateId,
      token,
    };
    const good = await api.handle("POST", url, { ...body });
    assert.equal(good?.status, 200);
    assert.ok(!JSON.stringify(good).includes(token));
    api.jobs.set("active", {
      job: { kind: "analysis", status: "running" } as any,
      controller: new AbortController(),
    });
    assert.equal((await api.handle("POST", url, { ...body }))?.status, 409);
    assert.equal(
      (
        await api.handle("POST", url, {
          action: "forget-session-auth",
          providerId: "claude",
          candidateId,
        })
      )?.status,
      409,
    );
    api.jobs.clear();
    for (const bad of [
      { ...body, path: "/arbitrary" },
      { ...body, providerId: "codex" },
    ]) {
      await assert.rejects(
        api.handle("POST", url, bad),
        /invalid engine setup request/,
      );
    }
    let release!: () => void, entered!: () => void;
    const begun = new Promise<void>((r) => {
      entered = r;
    });
    const held = new Promise<void>((r) => {
      release = r;
    });
    service.setSessionAuth = async () => {
      entered();
      await held;
      return service.status();
    };
    const pending = api.handle("POST", url, { ...body });
    await begun;
    assert.equal(
      (await api.handle("POST", new URL("http://localhost/api/live/run"), {}))
        ?.status,
      409,
    );
    assert.equal(
      (await api.handle("POST", url, { action: "rescan" }))?.status,
      409,
    );
    release();
    assert.equal((await pending)?.status, 200);
    service.setSessionAuth = async () => {
      throw Error(token);
    };
    const failed = await api.handle("POST", url, { ...body });
    assert.equal(failed?.status, 400);
    assert.ok(!JSON.stringify(failed).includes(token));
    assert.equal(api.store.list("config").length, 0);
  } finally {
    api.close();
    rmSync(root, { recursive: true, force: true });
  }
});
const token = "sk-ant-oat01-FAKE-setup-token-not-a-credential";
function fixture(
  options: {
    scratchRoot?: string;
    paused?: () => Promise<void>;
    unknown?: boolean;
    fail?: boolean;
  } = {},
) {
  let identity = "first";
  const service = createEngineSetupService(
    {},
    {
      ...(options.scratchRoot ? { scratchRoot: options.scratchRoot } : {}),
      resolve: async () => "/fake/claude",
      identity: async () => identity,
      probe: async (config) => {
        const auth = config?.providers?.claude?.auth;
        if (auth)
          assert.equal(
            (
              await prepareAuth("claude", auth, "/unused")
            ).env.CLAUDE_CODE_OAUTH_TOKEN.startsWith("sk-ant-oat01-"),
            true,
          );
        if (auth) {
          await options.paused?.();
          if (options.fail) throw Error(token);
        }
        const result = [
          {
            providerId: "claude",
            installed: true,
            cliVersion: "FAKE",
            capabilities: { supported: true, version: "FAKE", missing: [] },
            authentication: {
              status: options.unknown
                ? "unknown"
                : auth
                  ? "authenticated"
                  : "not_configured",
              method: auth ? "oauth-token" : null,
              checkedBy: "not-checked",
              networkValidated: false,
            },
            isolation: {
              backend: "unsupported",
              available: true,
              runtimeVerified: true,
            },
            ready: !!auth,
            inferenceVerified: false,
            blockers: [],
          },
        ] as any;
        return result;
      },
    },
  );
  return {
    service,
    replace: () => {
      identity = "second";
    },
  };
}
test("close cancels a paused token probe without resurrecting files or readiness", async () => {
  let release!: () => void, entered!: () => void;
  const begun = new Promise<void>((r) => (entered = r));
  const held = new Promise<void>((r) => (release = r));
  const root = mkdtempSync(join(tmpdir(), "session-close-"));
  const options = {
    scratchRoot: root,
    paused: async () => {
      entered();
      await held;
    },
  };
  const { service } = fixture(options);
  try {
    const candidate = (await service.status()).engines[0].candidateId!;
    const pending = service.setSessionAuth("claude", candidate, token);
    await begun;
    service.close();
    await assert.rejects(pending, { code: "cancelled" });
    assert.deepEqual(readdirSync(root), []);
    release();
    await assert.rejects(service.status(), { code: "cancelled" });
    await assert.rejects(service.resolveConfig("claude"), {
      code: "cancelled",
    });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    release?.();
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("bad tokens and failing probes are generic, revoke rotation, and unknown status is never ready", async () => {
  const options = { unknown: true, fail: false };
  const { service } = fixture(options);
  try {
    const id = (await service.status()).engines[0].candidateId!;
    const status = await service.setSessionAuth("claude", id, token);
    assert.equal(status.engines[0].ready, false);
    for (const invalid of [
      "sk-ant-api03-wrong",
      token + "\n",
      token + "\u0000",
      "sk-ant-oat01-" + "x".repeat(32768),
      "",
    ]) {
      await assert.rejects(service.setSessionAuth("claude", id, invalid), {
        code: "auth_invalid",
      });
      assert.equal(
        (await service.resolveConfig("claude")).providers?.claude?.auth,
        undefined,
      );
    }
    options.fail = true;
    await assert.rejects(
      service.setSessionAuth("claude", id, token),
      (e: any) => e.code === "auth_invalid" && !e.message.includes(token),
    );
    assert.equal(
      (await service.resolveConfig("claude")).providers?.claude?.auth,
      undefined,
    );
  } finally {
    service.close();
  }
});

test("Claude setup token is private, candidate-bound, rotated, forgotten and removed on close", async () => {
  const { service, replace } = fixture();
  try {
    const id = (await service.status()).engines[0].candidateId!;
    await assert.rejects(service.setSessionAuth("claude", "wrong", token));
    const status = await service.setSessionAuth("claude", id, token);
    assert.equal(status.engines[0].ready, true);
    assert.equal(status.engines[0].localAuth, "session");
    assert.ok(!JSON.stringify(status).includes(token));
    const auth = (await service.resolveConfig("claude")).providers!.claude!
      .auth!;
    assert.equal(auth.kind, "claude-oauth-token-file");
    assert.equal(readFileSync(auth.path, "utf8"), token);
    assert.equal(statSync(auth.path).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(auth.path)).mode & 0o777, 0o700);
    await service.setSessionAuth("claude", id, token + "-rotated");
    assert.equal(existsSync(auth.path), false);
    const rotated = (await service.resolveConfig("claude")).providers!.claude!
      .auth!.path;
    await service.forgetSessionAuth("claude", id);
    assert.equal(existsSync(rotated), false);
    assert.equal((await service.status()).engines[0].ready, false);
    await service.setSessionAuth("claude", id, token);
    const replaced = (await service.resolveConfig("claude")).providers!.claude!
      .auth!.path;
    replace();
    await assert.rejects(service.resolveConfig("claude"));
    assert.equal(existsSync(replaced), false);
    const next = (await service.rescan()).engines[0].candidateId!;
    await service.setSessionAuth("claude", next, token);
    const last = (await service.resolveConfig("claude")).providers!.claude!
      .auth!.path;
    service.close();
    assert.equal(existsSync(last), false);
    assert.equal(existsSync(dirname(last)), false);
    await assert.rejects(service.setSessionAuth("claude", next, token), {
      code: "cancelled",
    });
  } finally {
    service.close();
  }
});
