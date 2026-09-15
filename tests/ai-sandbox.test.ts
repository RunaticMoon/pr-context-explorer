import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { managedPolicyPresent } from "../src/server/ai/policy.ts";
import {
  buildBwrapArgs,
  probeSandbox,
  cleanEnvironment,
  projectRoot,
} from "../src/server/ai/sandbox.ts";

test("unmapped managed policy is detected, not silently omitted from isolated execution", async () => {
  const dir = await mkdtemp("/tmp/ai-policy-test-");
  try {
    assert.equal(await managedPolicyPresent([`${dir}/managed.json`]), false);
    await writeFile(`${dir}/managed.json`, "NOT PARSED");
    assert.equal(await managedPolicyPresent([`${dir}/managed.json`]), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project-owned native discovery is rooted at this project, not its parent", () => {
  assert.equal(
    projectRoot.replace(/\/$/, ""),
    new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
  );
});

test("bwrap construction creates disposable root without broad home/source/network mounts", () => {
  const args = buildBwrapArgs({
    nodePath: "/trusted/node",
    enginePath: "/trusted/codex",
    libraries: ["/lib/libc.so.6"],
    files: [
      { source: "/tmp/private/schema.json", target: "/runtime/schema.json" },
    ],
    command: ["/runtime/node", "-e", "fake probe"],
  });
  assert.ok(args.includes("--unshare-all"));
  assert.ok(args.includes("--unshare-user")); // required by --disable-userns even with --unshare-all
  assert.ok(args.includes("--die-with-parent"));
  assert.ok(args.includes("--disable-userns"));
  assert.ok(!args.includes("--share-net"));
  assert.deepEqual(
    args.slice(args.indexOf("--chdir"), args.indexOf("--chdir") + 2),
    ["--chdir", "/work"],
  );
  for (let i = 0; i < args.length; i++)
    if (args[i] === "--ro-bind" || args[i] === "--bind")
      assert.ok(
        !["/", "/home", "/tmp", "/usr", "/usr/bin", "/etc"].includes(
          args[i + 1],
        ),
        args[i + 1],
      );
  assert.equal(
    args.some((a) => a.includes("dangerously")),
    false,
  );
});
test("environment is an explicit engine-only whitelist, not process.env", () => {
  process.env.AI_TEST_SERVICE_TOKEN = "not-for-cli";
  try {
    const env = cleanEnvironment();
    assert.equal(env.AI_TEST_SERVICE_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.HOME, "/home/runner");
    assert.equal(env.PATH, "/runtime");
  } finally {
    delete process.env.AI_TEST_SERVICE_TOKEN;
  }
});
test(
  "actual kernel sandbox probe either proves fake isolation or fails closed",
  {
    skip:
      process.platform !== "linux" &&
      "Linux bwrap-specific; Darwin has mandatory runtime tests",
  },
  async () => {
    const result = await probeSandbox();
    assert.equal(result.backend, "linux-bwrap");
    assert.equal(result.runtimeVerified, result.available);
    if (result.available)
      assert.deepEqual(result.checks, {
        filesystem: true,
        environment: true,
        network: true,
        cwd: true,
      });
    else {
      assert.ok(result.blocker);
      assert.equal(result.runtimeVerified, false);
    }
  },
);
test(
  "missing sandbox cannot be considered a passing construction probe",
  {
    skip:
      process.platform !== "linux" &&
      "Linux bwrap-specific; Darwin has mandatory runtime tests",
  },
  async () => {
    const result = await probeSandbox({ bwrapPath: "/nonexistent/bwrap" });
    assert.equal(result.available, false);
    assert.equal(result.runtimeVerified, false);
  },
);
