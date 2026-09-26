import test from "node:test";
import assert from "node:assert/strict";
import {
  HttpEngineSetup,
  normalizeBaseUrl,
  type HttpVerifier,
} from "../src/server/http-engine-setup.ts";
import { HTTP_LIMITS } from "../src/ai-contract.ts";
import { AIError } from "../src/server/ai/errors.ts";
import type { HttpRuntimeConfig } from "../src/server/ai/types.ts";

const CANARY = "sk-live-CANARY-7f3a9b1c4d2e";
const NEW_KEY = "sk-live-REPLACEMENT-90ab";

const okVerifier: HttpVerifier = async () => {};

type ConfigureInput = Parameters<HttpEngineSetup["configure"]>[0];

function deferred<T = void>() {
  let resolve!: (v: T | PromiseLike<T>) => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Verifier that stays in flight until released or the signal aborts. */
function hangingVerifier() {
  const gate = deferred();
  const calls: { runtime: HttpRuntimeConfig; signal: AbortSignal }[] = [];
  const verifier: HttpVerifier = (runtime, signal) => {
    calls.push({ runtime, signal });
    return new Promise<void>((res, rej) => {
      signal.addEventListener("abort", () => rej(new AIError("cancelled")), {
        once: true,
      });
      gate.promise.then(res, rej);
    });
  };
  return { verifier, gate, calls };
}

let idSeq = 0;
function makeSetup(verifier: HttpVerifier = okVerifier) {
  return new HttpEngineSetup({
    verifier,
    randomId: () => `cfg-${++idSeq}`,
  });
}

function configureArgs(
  overrides: Partial<ConfigureInput> = {},
): ConfigureInput {
  return {
    providerId: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o-mini",
    apiKey: CANARY,
    ...overrides,
  };
}

function aiError(err: unknown): AIError {
  assert.ok(err instanceof AIError, `expected AIError, got ${String(err)}`);
  return err;
}

function thrown(fn: () => unknown): AIError {
  try {
    fn();
  } catch (err) {
    return aiError(err);
  }
  return assert.fail("expected a thrown AIError");
}

async function rejected(promise: Promise<unknown>): Promise<AIError> {
  try {
    await promise;
  } catch (err) {
    return aiError(err);
  }
  return assert.fail("expected a rejected AIError");
}

test("normalizeBaseUrl accepts http/https prefixes and strips trailing slashes", () => {
  assert.deepEqual(normalizeBaseUrl("https://api.example.com/v1/"), {
    baseUrl: "https://api.example.com/v1",
    host: "api.example.com",
  });
  assert.deepEqual(normalizeBaseUrl("http://localhost:11434"), {
    baseUrl: "http://localhost:11434",
    host: "localhost:11434",
  });
  assert.deepEqual(normalizeBaseUrl("https://EXAMPLE.com/"), {
    baseUrl: "https://example.com",
    host: "example.com",
  });
  assert.deepEqual(normalizeBaseUrl("https://x:8443/a/b//"), {
    baseUrl: "https://x:8443/a/b",
    host: "x:8443",
  });
});

test("normalizeBaseUrl rejects non-http(s), credentials, query, fragment, and completion suffix", () => {
  const bad = [
    "",
    "   ",
    "not-a-url",
    "/v1/relative",
    "api.example.com/v1",
    "ftp://api.example.com",
    "https://user@api.example.com",
    "https://user:pass@api.example.com/v1",
    "https://api.example.com/v1?token=1",
    "https://api.example.com/v1#frag",
    "https://api.example.com/chat/completions",
    "https://api.example.com/v1/chat/completions/",
    " https://api.example.com",
    "https://api.example.com /v1",
  ];
  for (const raw of bad) {
    assert.equal(
      thrown(() => normalizeBaseUrl(raw)).code,
      "invalid_request",
      raw,
    );
  }
});

test("normalizeBaseUrl rejects URLs with an empty authority", () => {
  // WHATWG parsing promotes the path into the host for these inputs, which
  // would silently redirect the API key to an unintended endpoint.
  const bad = [
    "http:///x",
    "http:///localhost:1234/v1",
    "https:///localhost/v1",
    "http://",
    "http://?q=1",
    "http://#frag",
    "http:\\\\x",
  ];
  for (const raw of bad) {
    assert.equal(
      thrown(() => normalizeBaseUrl(raw)).code,
      "invalid_request",
      raw,
    );
  }
  // Real authorities on the same shape still pass.
  assert.deepEqual(normalizeBaseUrl("http://localhost:1234/v1"), {
    baseUrl: "http://localhost:1234/v1",
    host: "localhost:1234",
  });
});

test("configure creates config with revision 1 and not_checked state", () => {
  const setup = makeSetup();
  assert.equal(setup.view(), null);
  const view = setup.configure(configureArgs());
  assert.equal(view.providerId, "openai-compatible");
  assert.equal(view.transport, "http");
  assert.equal(view.configId, `cfg-${idSeq}`);
  assert.equal(view.revision, 1);
  assert.equal(view.host, "api.example.com");
  assert.equal(view.model, "gpt-4o-mini");
  assert.equal(view.hasApiKey, true);
  assert.equal(view.verification, "not_checked");
  assert.equal(view.ready, false);
  assert.deepEqual(view.blockers, ["auth_required"]);
});

test("api key rules: required, size bound, whitespace and control chars rejected", () => {
  const setup = makeSetup();
  assert.equal(
    thrown(() => setup.configure(configureArgs({ apiKey: undefined }))).code,
    "auth_required",
  );
  const rejectedKeys = [
    "",
    "has space",
    "tab\ttab",
    "line\nbreak",
    "ctrl\x01key",
    "key\x7f",
    "k".repeat(HTTP_LIMITS.apiKeyMaxBytes + 1),
    // Multi-byte characters are measured in UTF-8 bytes, not length.
    "한".repeat(HTTP_LIMITS.apiKeyMaxBytes),
  ];
  for (const apiKey of rejectedKeys) {
    assert.equal(
      thrown(() => setup.configure(configureArgs({ apiKey }))).code,
      "invalid_request",
      JSON.stringify(apiKey).slice(0, 40),
    );
  }
  assert.equal(setup.view(), null);
  // Exactly at the byte cap is accepted.
  setup.configure(
    configureArgs({ apiKey: "k".repeat(HTTP_LIMITS.apiKeyMaxBytes) }),
  );
  assert.equal(setup.view()?.hasApiKey, true);
});

test("model and provider validation", () => {
  const setup = makeSetup();
  for (const model of ["", "has space", "bad\nmodel", "x".repeat(121)]) {
    assert.equal(
      thrown(() => setup.configure(configureArgs({ model }))).code,
      "invalid_request",
      model,
    );
  }
  for (const model of ["gpt-4o-mini", "org/model:tag", "a.b_c-d/e:f"]) {
    const s = makeSetup();
    s.configure(configureArgs({ model }));
    assert.equal(s.view()?.model, model);
  }
  assert.equal(
    thrown(() =>
      setup.configure(
        configureArgs({ providerId: "codex" as "openai-compatible" }),
      ),
    ).code,
    "invalid_request",
  );
});

test("configure on existing config requires matching configId and expectedRevision", () => {
  const setup = makeSetup();
  const first = setup.configure(configureArgs());
  for (const bad of [
    { configId: "wrong", expectedRevision: first.revision },
    { configId: first.configId, expectedRevision: 99 },
    { configId: first.configId },
    { expectedRevision: first.revision },
    {},
  ]) {
    assert.equal(
      thrown(() => setup.configure(configureArgs(bad))).code,
      "invalid_request",
    );
  }
  // A fresh configure must not carry identity fields.
  const fresh = makeSetup();
  assert.equal(
    thrown(() =>
      fresh.configure(
        configureArgs({ configId: "cfg-x", expectedRevision: 0 }),
      ),
    ).code,
    "invalid_request",
  );
});

test("same-endpoint update keeps the stored key; every change bumps revision and notifies", () => {
  const setup = makeSetup();
  const invalidated: string[] = [];
  setup.onInvalidate((id) => invalidated.push(id));
  const first = setup.configure(configureArgs());
  const second = setup.configure(
    configureArgs({
      apiKey: undefined,
      configId: first.configId,
      expectedRevision: first.revision,
      model: "gpt-4o",
    }),
  );
  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.hasApiKey, true);
  assert.equal(second.model, "gpt-4o");
  assert.equal(second.verification, "not_checked");
  assert.deepEqual(invalidated, [first.configId]);
});

test("endpoint change requires a new key and never reuses the old one", async () => {
  const calls: HttpRuntimeConfig[] = [];
  const setup = makeSetup(async (runtime) => {
    calls.push(runtime);
  });
  const first = setup.configure(configureArgs());
  // Endpoint change without a key is refused and leaves the old config intact.
  assert.equal(
    thrown(() =>
      setup.configure(
        configureArgs({
          baseUrl: "https://other.example.com/v1",
          apiKey: undefined,
          configId: first.configId,
          expectedRevision: first.revision,
        }),
      ),
    ).code,
    "auth_required",
  );
  assert.equal(setup.view()?.host, "api.example.com");
  assert.equal(setup.view()?.revision, first.revision);
  // Endpoint change with a new key succeeds; the old key is never sent again.
  const moved = setup.configure(
    configureArgs({
      baseUrl: "https://other.example.com/v1",
      apiKey: NEW_KEY,
      configId: first.configId,
      expectedRevision: first.revision,
    }),
  );
  assert.equal(moved.revision, first.revision + 1);
  assert.equal(moved.host, "other.example.com");
  const checked = await setup.verify({
    configId: moved.configId,
    revision: moved.revision,
    consent: true,
  });
  assert.equal(checked.verification, "verified");
  assert.equal(calls.at(-1)?.getApiKey(), NEW_KEY);
  assert.notEqual(calls.at(-1)?.getApiKey(), CANARY);
});

test("verify success marks verified and ready; resolve returns runtime with key closure", async () => {
  const setup = makeSetup(async (runtime) => {
    assert.equal(runtime.baseUrl, "https://api.example.com/v1");
    assert.equal(runtime.host, "api.example.com");
    assert.equal(runtime.model, "gpt-4o-mini");
    assert.equal(runtime.getApiKey(), CANARY);
  });
  const view = setup.configure(configureArgs());
  const checked = await setup.verify({
    configId: view.configId,
    revision: view.revision,
    consent: true,
  });
  assert.equal(checked.verification, "verified");
  assert.equal(checked.ready, true);
  assert.deepEqual(checked.blockers, []);
  assert.equal(setup.resolve().getApiKey(), CANARY);
});

test("verify requires consent, matching configId/revision, and a stored key", async () => {
  const setup = makeSetup();
  const view = setup.configure(configureArgs());
  for (const bad of [
    { configId: "wrong", revision: view.revision, consent: true as const },
    { configId: view.configId, revision: 42, consent: true as const },
    {
      configId: view.configId,
      revision: view.revision,
      consent: false as unknown as true,
    },
  ]) {
    assert.equal((await rejected(setup.verify(bad))).code, "invalid_request");
  }
  const empty = makeSetup();
  assert.equal(
    (
      await rejected(
        empty.verify({ configId: "x", revision: 1, consent: true }),
      )
    ).code,
    "invalid_request",
  );
  // Config without a key (after forget) cannot be checked.
  const keyless = makeSetup();
  const kv = keyless.configure(configureArgs());
  keyless.forget({ configId: kv.configId, revision: kv.revision });
  const after = keyless.view();
  assert.ok(after);
  assert.equal(
    (
      await rejected(
        keyless.verify({
          configId: after.configId,
          revision: after.revision,
          consent: true,
        }),
      )
    ).code,
    "auth_required",
  );
});

test("verify runs one at a time and reports checking state", async () => {
  const { verifier, gate } = hangingVerifier();
  const setup = makeSetup(verifier);
  const view = setup.configure(configureArgs());
  const pending = setup.verify({
    configId: view.configId,
    revision: view.revision,
    consent: true,
  });
  assert.equal(setup.view()?.verification, "checking");
  assert.equal(
    (
      await rejected(
        setup.verify({
          configId: view.configId,
          revision: view.revision,
          consent: true,
        }),
      )
    ).code,
    "invalid_request",
  );
  gate.resolve();
  assert.equal((await pending).verification, "verified");
});

test("verify discards a late result after reconfigure superseded the revision", async () => {
  const { verifier, gate } = hangingVerifier();
  const setup = makeSetup(verifier);
  const first = setup.configure(configureArgs());
  const pending = setup.verify({
    configId: first.configId,
    revision: first.revision,
    consent: true,
  });
  assert.equal(setup.view()?.verification, "checking");
  const second = setup.configure(
    configureArgs({
      apiKey: undefined,
      configId: first.configId,
      expectedRevision: first.revision,
      model: "gpt-4o",
    }),
  );
  assert.equal(second.verification, "not_checked");
  gate.resolve();
  const result = await pending;
  assert.equal(result.revision, second.revision);
  assert.equal(result.verification, "not_checked");
  assert.equal(result.ready, false);
});

test("configure frees the verify slot even when the aborted check ignores the signal", async () => {
  // A verifier that never observes abort: each call settles only when released.
  const releases: (() => void)[] = [];
  const verifier: HttpVerifier = () =>
    new Promise<void>((resolve) => {
      releases.push(() => resolve());
    });
  const setup = makeSetup(verifier);
  const first = setup.configure(configureArgs());
  const stale = setup.verify({
    configId: first.configId,
    revision: first.revision,
    consent: true,
  });
  assert.equal(setup.view()?.verification, "checking");
  const second = setup.configure(
    configureArgs({
      apiKey: undefined,
      configId: first.configId,
      expectedRevision: first.revision,
      model: "gpt-4o",
    }),
  );
  // The aborted check is still in flight, yet the new revision can verify.
  const fresh = setup.verify({
    configId: second.configId,
    revision: second.revision,
    consent: true,
  });
  assert.equal(setup.view()?.verification, "checking");
  releases[1]();
  const freshView = await fresh;
  assert.equal(freshView.revision, second.revision);
  assert.equal(freshView.verification, "verified");
  assert.equal(freshView.ready, true);
  // The superseded check settles late; it must not clobber the new state.
  releases[0]();
  const staleView = await stale;
  assert.equal(staleView.revision, second.revision);
  assert.equal(staleView.verification, "verified");
  assert.equal(setup.view()?.verification, "verified");
  assert.equal(setup.view()?.revision, second.revision);
});

test("forget frees the verify slot; configure and a fresh check still work", async () => {
  const { verifier, gate } = hangingVerifier();
  const setup = makeSetup(verifier);
  const first = setup.configure(configureArgs());
  const stale = setup.verify({
    configId: first.configId,
    revision: first.revision,
    consent: true,
  });
  assert.equal(setup.view()?.verification, "checking");
  const forgotten = setup.forget({
    configId: first.configId,
    revision: first.revision,
  });
  assert.ok(forgotten);
  const staleView = await stale;
  assert.equal(staleView.revision, forgotten.revision);
  assert.equal(staleView.verification, "not_checked");
  const restored = setup.configure(
    configureArgs({
      apiKey: NEW_KEY,
      configId: forgotten.configId,
      expectedRevision: forgotten.revision,
    }),
  );
  const pending = setup.verify({
    configId: restored.configId,
    revision: restored.revision,
    consent: true,
  });
  gate.resolve();
  const checked = await pending;
  assert.equal(checked.verification, "verified");
  assert.equal(checked.ready, true);
});

test("verify failure records the AIError code as the blocker; resolve throws it", async () => {
  const setup = makeSetup(async () => {
    throw new AIError("auth_invalid");
  });
  const view = setup.configure(configureArgs());
  const checked = await setup.verify({
    configId: view.configId,
    revision: view.revision,
    consent: true,
  });
  assert.equal(checked.verification, "failed");
  assert.deepEqual(checked.blockers, ["auth_invalid"]);
  assert.equal(checked.ready, false);
  assert.equal(thrown(() => setup.resolve()).code, "auth_invalid");
});

test("verify maps non-AIError failures to provider_failed", async () => {
  const setup = makeSetup(async () => {
    throw new Error(`provider rejected ${CANARY}`);
  });
  const view = setup.configure(configureArgs());
  const checked = await setup.verify({
    configId: view.configId,
    revision: view.revision,
    consent: true,
  });
  assert.equal(checked.verification, "failed");
  assert.deepEqual(checked.blockers, ["provider_failed"]);
  assert.equal(JSON.stringify(checked).includes(CANARY), false);
});

test("caller signal cancels a verify and restores not_checked", async () => {
  const { verifier } = hangingVerifier();
  const setup = makeSetup(verifier);
  const view = setup.configure(configureArgs());
  const caller = new AbortController();
  const pending = setup.verify(
    { configId: view.configId, revision: view.revision, consent: true },
    caller.signal,
  );
  caller.abort();
  assert.equal((await rejected(pending)).code, "cancelled");
  assert.equal(setup.view()?.verification, "not_checked");
  assert.equal(setup.view()?.ready, false);
});

test("replacing the key after verification never resurrects ready on its own", async () => {
  // The verifier rejects the rotated key, mirroring a wrong-password swap.
  const setup = makeSetup(async (runtime) => {
    if (runtime.getApiKey() !== CANARY) throw new AIError("auth_invalid");
  });
  const first = setup.configure(configureArgs());
  const checked = await setup.verify({
    configId: first.configId,
    revision: first.revision,
    consent: true,
  });
  assert.equal(checked.ready, true);
  const rotated = setup.configure(
    configureArgs({
      apiKey: "sk-bad-replacement",
      configId: first.configId,
      expectedRevision: first.revision,
    }),
  );
  assert.equal(rotated.ready, false);
  assert.equal(rotated.verification, "not_checked");
  assert.equal(thrown(() => setup.resolve()).code, "auth_required");
  // A failed check on the bad key keeps ready false; nothing revives it.
  const failed = await setup.verify({
    configId: rotated.configId,
    revision: rotated.revision,
    consent: true,
  });
  assert.equal(failed.verification, "failed");
  assert.equal(failed.ready, false);
  assert.deepEqual(failed.blockers, ["auth_invalid"]);
  assert.equal(thrown(() => setup.resolve()).code, "auth_invalid");
});

test("forget removes the key, bumps revision, and keeps the endpoint", () => {
  const setup = makeSetup();
  const invalidated: string[] = [];
  setup.onInvalidate((id) => invalidated.push(id));
  const view = setup.configure(configureArgs());
  assert.equal(
    thrown(() => setup.forget({ configId: view.configId, revision: 99 })).code,
    "invalid_request",
  );
  const forgotten = setup.forget({
    configId: view.configId,
    revision: view.revision,
  });
  assert.ok(forgotten);
  assert.equal(forgotten.hasApiKey, false);
  assert.equal(forgotten.ready, false);
  assert.equal(forgotten.verification, "not_checked");
  assert.equal(forgotten.revision, view.revision + 1);
  assert.equal(forgotten.host, "api.example.com");
  assert.deepEqual(forgotten.blockers, ["auth_required"]);
  assert.deepEqual(invalidated, [view.configId]);
  assert.equal(thrown(() => setup.resolve()).code, "auth_required");
  // Same endpoint without a key is refused now that the key is gone.
  assert.equal(
    thrown(() =>
      setup.configure(
        configureArgs({
          apiKey: undefined,
          configId: forgotten.configId,
          expectedRevision: forgotten.revision,
        }),
      ),
    ).code,
    "auth_required",
  );
  const empty = makeSetup();
  assert.equal(empty.forget({ configId: "x", revision: 1 }), null);
});

test("close aborts an in-flight verify, clears state, and refuses further calls", async () => {
  const { verifier } = hangingVerifier();
  const setup = makeSetup(verifier);
  const view = setup.configure(configureArgs());
  const pending = setup.verify({
    configId: view.configId,
    revision: view.revision,
    consent: true,
  });
  setup.close();
  assert.equal((await rejected(pending)).code, "cancelled");
  assert.equal(setup.view(), null);
  assert.equal(
    thrown(() => setup.forget({ configId: view.configId, revision: 2 })).code,
    "cancelled",
  );
  assert.equal(
    thrown(() => setup.configure(configureArgs())).code,
    "cancelled",
  );
  assert.equal(thrown(() => setup.resolve()).code, "cancelled");
  setup.close(); // idempotent
});

test("canary key never appears in view, serialization, or error text", async () => {
  const setup = makeSetup(async () => {
    throw new AIError("auth_invalid");
  });
  const view = setup.configure(configureArgs());
  const checked = await setup.verify({
    configId: view.configId,
    revision: view.revision,
    consent: true,
  });
  for (const target of [
    JSON.stringify(setup),
    JSON.stringify(setup.view()),
    JSON.stringify(view),
    JSON.stringify(checked),
  ]) {
    assert.equal(target.includes(CANARY), false, target);
  }
  for (const err of [
    thrown(() =>
      setup.configure(configureArgs({ configId: "bad", expectedRevision: 0 })),
    ),
    thrown(() => setup.resolve()),
    thrown(() => normalizeBaseUrl("https://u:p@x/" + CANARY)),
    await rejected(
      setup.verify({ configId: "bad", revision: 1, consent: true }),
    ),
  ]) {
    assert.equal(`${err.message}\n${err.stack}`.includes(CANARY), false);
  }
});

test("runtime captured before reconfigure cannot vend its key afterwards", async () => {
  const calls: HttpRuntimeConfig[] = [];
  const setup = makeSetup(async (runtime) => {
    calls.push(runtime);
  });
  const first = setup.configure(configureArgs());
  await setup.verify({
    configId: first.configId,
    revision: first.revision,
    consent: true,
  });
  const stale = calls[0];
  assert.equal(stale.getApiKey(), CANARY);
  setup.configure(
    configureArgs({
      configId: first.configId,
      expectedRevision: first.revision,
      model: "gpt-4o",
    }),
  );
  assert.equal(thrown(() => stale.getApiKey()).code, "cancelled");
});

test("onInvalidate unsubscribe stops notifications", () => {
  const setup = makeSetup();
  const seen: string[] = [];
  const off = setup.onInvalidate((id) => seen.push(id));
  const first = setup.configure(configureArgs());
  setup.configure(
    configureArgs({
      configId: first.configId,
      expectedRevision: first.revision,
    }),
  );
  off();
  const second = setup.view();
  assert.ok(second);
  setup.configure(
    configureArgs({
      configId: second.configId,
      expectedRevision: second.revision,
    }),
  );
  assert.deepEqual(seen, [first.configId]);
});
