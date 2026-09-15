import test from "node:test";
import assert from "node:assert/strict";
import { probeProviders, runAnalysis } from "../src/server/ai/index.ts";

const request = {
  providerId: "codex" as const,
  model: "selected-model",
  schema: { type: "object" },
  context: { source: "fake source" },
  trustedPrompt: "trusted instructions",
};
test("provider probes never turn missing engines/auth/isolation into ready providers", async () => {
  const providers = await probeProviders({
    providers: {
      codex: { executablePath: "/nonexistent/codex" },
      claude: { executablePath: "/nonexistent/claude" },
    },
  });
  assert.equal(providers.length, 2);
  for (const p of providers) {
    assert.equal(p.installed, false);
    assert.equal(p.ready, false);
    assert.ok(p.blockers.includes("cli_missing"));
    assert.notEqual(p.authentication.status, "authenticated");
  }
});
test("pre-abort is honoured before any CLI, sandbox or credential discovery", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runAnalysis({ ...request, signal: controller.signal }), {
    code: "cancelled",
  });
});
test("input caps reject the whole request, never silently trim source", async () => {
  await assert.rejects(
    runAnalysis({
      ...request,
      context: { source: "x".repeat(512) },
      config: { maxInputBytes: 128 },
    }),
    { code: "input_limit" },
  );
});
test("invalid schema or model is rejected before launching the CLI", async () => {
  await assert.rejects(runAnalysis({ ...request, schema: { type: "bogus" } }), {
    code: "schema_invalid",
  });
  await assert.rejects(
    runAnalysis({
      ...request,
      model: "--dangerously-bypass-approvals-and-sandbox",
    }),
    { code: "invalid_request" },
  );
});
test("unavailable sandbox fails closed before reading any authorized credential path", async () => {
  await assert.rejects(
    runAnalysis({
      ...request,
      config: {
        sandbox: {
          bwrapPath: "/nonexistent/bwrap",
          runtimeNodePath: "/nonexistent/official-node",
        },
        providers: {
          codex: {
            auth: {
              kind: "codex-auth-file",
              path: "/intentionally-unreadable/auth.json",
            },
          },
        },
      },
    }),
    { code: "sandbox_unavailable" },
  );
});
test("unavailable isolation wins even when both engine and auth are absent", async () => {
  await assert.rejects(
    runAnalysis({
      ...request,
      config: {
        sandbox: {
          bwrapPath: "/nonexistent/bwrap",
          runtimeNodePath: "/nonexistent/official-node",
        },
        providers: { codex: { executablePath: "/nonexistent/cli" } },
      },
    }),
    { code: "sandbox_unavailable" },
  );
});
test("full request deadline includes preflight work", async () => {
  await assert.rejects(runAnalysis({ ...request, config: { deadlineMs: 1 } }), {
    code: "timeout",
  });
});
test("actual provider probes are capability evidence, not inference or account entitlement", async () => {
  const providers = await probeProviders();
  for (const p of providers) {
    assert.equal(p.inferenceVerified, false);
    assert.equal(p.authentication.status, "not_configured");
    assert.equal(p.ready, false);
    assert.ok(p.blockers.includes("auth_required"));
  }
});
