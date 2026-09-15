import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildInvocation,
  inspectCapabilities,
  parseAuthStatus,
} from "../src/server/ai/cli.ts";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
test("Codex flags enforce verified restrictions and source bundle travels only in stdin", () => {
  const invocation = buildInvocation("codex", {
    model: "user-model",
    schema,
    trustedPrompt: "TRUSTED APP INSTRUCTIONS",
    context: { source: "UNTRUSTED SOURCE" },
    authMode: "oauth-file",
  });
  assert.equal(
    invocation.args.includes("--dangerously-bypass-approvals-and-sandbox"),
    false,
  );
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("--ignore-rules"));
  assert.ok(invocation.args.includes("read-only"));
  assert.ok(invocation.args.includes("shell_tool"));
  assert.equal(invocation.args.join(" ").includes("UNTRUSTED SOURCE"), false);
  assert.deepEqual(JSON.parse(invocation.stdin), {
    SOURCE_BUNDLE_JSON: { source: "UNTRUSTED SOURCE" },
  });
});
test("Claude OAuth uses safe/restricted mode, not bare mode which disables OAuth", () => {
  const request = {
    model: "user-model",
    schema,
    trustedPrompt: "trusted",
    context: { x: 1 },
    authMode: "oauth-token" as const,
  };
  const oauth = buildInvocation("claude", request);
  assert.ok(oauth.args.includes("--safe-mode"));
  assert.ok(oauth.args.includes("--restricted"));
  assert.equal(oauth.args.includes("--bare"), false);
  assert.equal(oauth.args[oauth.args.indexOf("--tools") + 1], "");
  assert.ok(oauth.args.includes("--strict-mcp-config"));
  assert.equal(oauth.args.includes("--fallback-model"), false);
});
test("capability verification is pinned to installed help and exact reviewed versions", async () => {
  const evidence = JSON.parse(
    await readFile(
      new URL("../artifacts/ai-cli-verification.json", import.meta.url),
      "utf8",
    ),
  ) as Array<{ provider: string; args: string[]; stdout: string }>;
  for (const provider of ["codex", "claude"] as const) {
    const version = evidence.find(
      (r) => r.provider === provider && r.args[0] === "--version",
    )!.stdout;
    const help = evidence
      .filter((r) => r.provider === provider && r.args.includes("--help"))
      .map((r) => r.stdout)
      .join("\n");
    const features =
      evidence.find((r) => r.provider === provider && r.args[0] === "features")
        ?.stdout ?? "";
    assert.equal(
      inspectCapabilities(provider, version, help, features).supported,
      true,
    );
    assert.equal(
      inspectCapabilities(provider, "99.99.99", help, features).supported,
      false,
    );
    assert.equal(
      inspectCapabilities(provider, version, "", features).supported,
      false,
    );
  }
});
test("auth status distinguishes false, explicit CLI confirmation and malformed responses", () => {
  assert.equal(
    parseAuthStatus("claude", 0, '{"loggedIn":true}', ""),
    "authenticated",
  );
  assert.equal(
    parseAuthStatus("claude", 1, '{"loggedIn":false}', ""),
    "not_authenticated",
  );
  assert.equal(parseAuthStatus("claude", 0, "{}", ""), "unknown");
  assert.equal(
    parseAuthStatus("codex", 0, "", "Logged in using ChatGPT"),
    "authenticated",
  );
  assert.equal(
    parseAuthStatus("codex", 1, "", "Not logged in"),
    "not_authenticated",
  );
});
