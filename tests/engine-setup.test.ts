import {
  chmod,
  copyFile,
  realpath,
  mkdtemp,
  rename,
  rm,
  open,
} from "node:fs/promises";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForFixture } from "./wait-for-fixture.ts";
import assert from "node:assert/strict";
import { createEngineSetupService } from "../src/server/engine-setup.ts";
import type { ProviderProbe } from "../src/server/ai/types.ts";
const probe = (providerId: "codex" | "claude"): ProviderProbe => ({
  providerId,
  installed: false,
  cliVersion: null,
  capabilities: { supported: false, version: null, missing: ["cli_missing"] },
  authentication: {
    status: "not_configured",
    method: null,
    checkedBy: "not-checked",
    networkValidated: false,
  },
  isolation: {
    backend: "unsupported",
    available: false,
    runtimeVerified: false,
    blocker: "sandbox_unavailable",
  },
  blockers: ["cli_missing", "sandbox_unavailable", "auth_required"],
  ready: false,
  inferenceVerified: false,
});
test("discovery exposes installed independently of compatibility; consent alone wires auth", async () => {
  const configs: any[] = [];
  const service = createEngineSetupService(
    {},
    {
      home: "/actual",
      identity: async (path) => path,
      resolve: async () => "/approved/codex",
      probe: async (config) => {
        configs.push(config);
        return [probe("codex"), probe("claude")];
      },
      authMetadata: async () => true,
    },
  );
  const before = await service.status();
  assert.equal(before.engines[0].installed, true);
  assert.equal(before.engines[0].ready, false);
  assert.equal(before.engines[0].localAuth, "available");
  assert.equal(configs[0].providers.codex.auth, undefined);
  await assert.rejects(service.reuseLocalAuth("codex", "arbitrary-path"));
  await service.reuseLocalAuth("codex", before.engines[0].candidateId!);
  const config = await service.resolveConfig("codex");
  assert.deepEqual(config.providers?.codex?.auth, {
    kind: "codex-auth-file",
    path: "/actual/.codex/auth.json",
  });
  await assert.rejects(
    service.reuseLocalAuth("claude", before.engines[1].candidateId!),
  );
  assert.ok(!JSON.stringify(await service.status()).includes("/actual"));
});

test(
  "same-path native replacement and same-size writes revoke consent",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "engine-identity-")),
    );
    const path = `${root}/codex`;
    try {
      await copyFile("/usr/bin/true", path);
      await chmod(path, 0o700);
      const service = createEngineSetupService(
        { providers: { codex: { executablePath: path } } },
        {
          probe: async () => [probe("codex")],
          authMetadata: async () => true,
        },
      );
      const first = (await service.status()).engines[0].candidateId!;
      assert.equal((await service.rescan()).engines[0].candidateId, first);
      await service.reuseLocalAuth("codex", first);
      await copyFile("/usr/bin/false", `${path}.new`);
      await chmod(`${path}.new`, 0o700);
      await rename(`${path}.new`, path);
      await assert.rejects(service.resolveConfig("codex"));
      const second = (await service.rescan()).engines[0];
      assert.notEqual(second.candidateId, first);
      assert.equal(second.localAuth, "available");
      await service.reuseLocalAuth("codex", second.candidateId!);
      const file = await open(path, "r+");
      const s = await file.stat();
      await file.write(Buffer.from([42]), 0, 1, s.size - 1);
      await file.close();
      await assert.rejects(service.resolveConfig("codex"));
      assert.notEqual(
        (await service.rescan()).engines[0].candidateId,
        second.candidateId,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("close aborts pending probes immediately and permanently prevents late status or consent", async () => {
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>((r) => (started = r));
  let signal: AbortSignal | undefined;
  const service = createEngineSetupService(
    {},
    {
      resolve: async () => "/fake",
      identity: async () => "one",
      authMetadata: async () => true,
      probe: async (_config, s) => {
        signal = s;
        started();
        await new Promise<void>((r) => (release = r));
        return [probe("codex")];
      },
    },
  );
  try {
    const result = service.status();
    await waitForFixture(begun, result);
    assert.equal(typeof service.close, "function");
    service.close();
    assert.equal(signal?.aborted, true);
    await assert.rejects(result, { code: "cancelled" });
    release();
    await assert.rejects(service.status(), { code: "cancelled" });
    await assert.rejects(service.rescan(), { code: "cancelled" });
    await assert.rejects(service.resolveConfig("codex"), { code: "cancelled" });
    await assert.rejects(service.reuseLocalAuth("codex", "one"), {
      code: "cancelled",
    });
  } finally {
    release?.();
    service.close();
  }
});

test("consent revalidates after asynchronous auth metadata and concurrent rescan cannot restore it", async () => {
  let identity = "one",
    mutate = false;
  const service = createEngineSetupService(
    {},
    {
      resolve: async () => "/fake",
      identity: async () => identity,
      probe: async () => [probe("codex")],
      authMetadata: async () => {
        if (mutate) identity = "two";
        return true;
      },
    },
  );
  const first = (await service.status()).engines[0];
  mutate = true;
  const consent = service.reuseLocalAuth("codex", first.candidateId!);
  const refresh = service.rescan();
  await assert.rejects(consent, { code: "auth_invalid" });
  assert.equal((await refresh).engines[0].localAuth, "available");
  assert.equal(
    (await service.resolveConfig("codex")).providers?.codex?.auth,
    undefined,
  );
});

test("authenticated status probes revalidate consent immediately before credential handling", async () => {
  let identity = "one",
    receivedAuth = false;
  const service = createEngineSetupService(
    {},
    {
      resolve: async () => "/fake",
      identity: async () => identity,
      authMetadata: async () => true,
      probe: async (config, _signal, validate) => {
        if (config?.providers?.codex?.auth) {
          identity = "two";
          assert.equal(typeof validate, "function");
          await validate!("codex", "/fake");
          receivedAuth = true;
        }
        return [probe("codex")];
      },
    },
  );
  const first = (await service.status()).engines[0];
  await assert.rejects(service.reuseLocalAuth("codex", first.candidateId!), {
    code: "auth_invalid",
  });
  assert.equal(receivedAuth, false);
  assert.equal((await service.rescan()).engines[0].localAuth, "available");
});

test("late probe readiness cannot revive a replaced executable or its consent", async () => {
  let identity = "one",
    replaceDuringProbe = false;
  const ready = {
    ...probe("codex"),
    ready: true,
    capabilities: { supported: true, version: "fake", missing: [] },
    authentication: {
      ...probe("codex").authentication,
      status: "authenticated" as const,
    },
    isolation: {
      ...probe("codex").isolation,
      available: true,
      runtimeVerified: true,
    },
  };
  const service = createEngineSetupService(
    {},
    {
      resolve: async () => "/fake",
      identity: async () => identity,
      authMetadata: async () => true,
      probe: async () => {
        if (replaceDuringProbe) identity = "two";
        return [ready];
      },
    },
  );
  const first = (await service.status()).engines[0];
  await service.reuseLocalAuth("codex", first.candidateId!);
  replaceDuringProbe = true;
  const [stale, fresh] = await Promise.all([
    service.rescan(),
    service.rescan(),
  ]);
  assert.equal(stale.engines[0].ready, false);
  assert.equal(fresh.engines[0].localAuth, "available");
  assert.equal(fresh.engines[0].ready, false);
  assert.notEqual(fresh.engines[0].candidateId, first.candidateId);
  assert.equal(
    (await service.resolveConfig("codex")).providers?.codex?.auth,
    undefined,
  );
});

test("close during consent metadata rejects without restoring consent", async () => {
  let hold = false,
    entered!: () => void,
    release!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  const service = createEngineSetupService(
    {},
    {
      resolve: async () => "/fake",
      identity: async () => "one",
      probe: async () => [probe("codex")],
      authMetadata: async () => {
        if (hold) {
          entered();
          await new Promise<void>((r) => (release = r));
        }
        return true;
      },
    },
  );
  try {
    const first = (await service.status()).engines[0];
    hold = true;
    const consent = service.reuseLocalAuth("codex", first.candidateId!);
    await waitForFixture(started, consent);
    service.close();
    await assert.rejects(consent, { code: "cancelled" });
    release();
    await assert.rejects(service.status(), { code: "cancelled" });
  } finally {
    release?.();
    service.close();
  }
});

test("changed installation invalidates consent and candidate IDs, advanced auth remains server-owned", async () => {
  let executable = "/approved/first";
  const service = createEngineSetupService(
    {
      providers: {
        claude: {
          auth: {
            kind: "claude-oauth-token-file",
            path: "/private/server-token",
          },
        },
      },
    },
    {
      home: "/actual",
      identity: async (path) => path,
      resolve: async () => executable,
      probe: async () => [probe("codex"), probe("claude")],
      authMetadata: async () => true,
    },
  );
  const first = await service.status();
  await service.reuseLocalAuth("codex", first.engines[0].candidateId!);
  executable = "/approved/replacement";
  const next = await service.rescan();
  assert.notEqual(next.engines[0].candidateId, first.engines[0].candidateId);
  await assert.rejects(
    service.reuseLocalAuth("codex", first.engines[0].candidateId!),
  );
  const config = await service.resolveConfig("claude");
  assert.equal(config.providers?.codex?.auth, undefined);
  assert.equal(config.providers?.claude?.auth?.path, "/private/server-token");
  assert.ok(!JSON.stringify(next).includes("/private/"));
});
