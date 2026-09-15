import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as diagnostics from "../scripts/macos-ai-diagnostics.ts";
import { runRootDirectoryAB } from "../scripts/mac-native-ab.ts";
import { validateMacSystemPolicyReads } from "../src/server/ai/macos.ts";
import { AIError } from "../src/server/ai/errors.ts";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

for (const leaf of [
  "/System/Library/OpenSSL/openssl.cnf",
  "/private/etc/codex/requirements.toml",
  "/private/etc/codex/managed_config.toml",
  "/private/etc/codex/config.toml",
])
  for (const state of ["regular", "symlink", "unknown"] as const)
    test(`fixed policy leaf ${leaf} (${state}) is attributed before the original guard blocks main`, async (t) => {
      const spawn = t.mock.method(childProcess, "spawn", () => {
        throw new Error("forbidden child launch");
      });
      syncBuiltinESMExports();
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
      const argv = process.argv;
      const log = console.log;
      const reports: Array<{ stage: string; value: any }> = [];
      const seen: string[] = [];
      const fs = {
        async lstat(path: string) {
          seen.push(path);
          if (
            (path.endsWith(".cnf") || path.endsWith(".toml")) &&
            path !== leaf
          )
            throw Object.assign(new Error("/Users/private-user/secret"), {
              code: "ENOENT",
            });
          if (path === leaf && state === "unknown")
            throw Object.assign(new Error("/Users/private-user/secret"), {
              code: "/Users/private-user/raw-error",
            });
          return {
            uid: 0,
            mode: path === leaf ? 0o100644 : 0o40755,
            isDirectory: () => path !== leaf && path !== "/etc",
            isSymbolicLink: () =>
              path === "/etc" || (path === leaf && state === "symlink"),
          };
        },
        async readlink(path: string) {
          assert.equal(
            path,
            "/etc",
            "diagnostics must not read policy link targets",
          );
          return "private/etc";
        },
        async readAcl() {
          return '{"version":1,"status":"empty"}\n';
        },
        async readFile() {
          assert.fail("never read policy contents");
        },
      };
      try {
        Object.defineProperty(process, "platform", { value: "darwin" });
        Object.defineProperty(process, "arch", { value: "arm64" });
        process.argv = [argv[0], argv[1], "--startup-help-only=claude"];
        console.log = (line: string) => reports.push(JSON.parse(line));
        await assert.rejects(
          diagnostics.main(fs),
          (e: unknown) =>
            e instanceof AIError && e.code === "managed_policy_unsupported",
        );
        assert.deepEqual(reports.at(-2), {
          stage: "system-policy-metadata",
          value:
            state === "unknown"
              ? { path: leaf, exists: "unknown" }
              : {
                  path: leaf,
                  exists: true,
                  uid: 0,
                  mode: "644",
                  fileType: state,
                },
        });
        assert.deepEqual(reports.at(-1), {
          stage: "system-policy-preflight-blocked",
          value: {
            source: "validateMacSystemPolicyReads",
            code: "managed_policy_unsupported",
            lastInspectedPath: leaf,
          },
        });
        assert.equal(
          spawn.mock.callCount(),
          0,
          "no target child after rejection",
        );
        assert.equal(seen.at(-1), leaf);
        assert.equal(
          new Set(seen).size,
          seen.length,
          "reuse guard observations, no second stat",
        );
        assert.doesNotMatch(
          JSON.stringify(reports),
          /private-user|raw-error|secret/,
        );
        for (const { stage, value } of reports)
          if (
            stage === "system-policy-metadata" &&
            value.path !== leaf &&
            /\.(cnf|toml)$/.test(value.path)
          )
            assert.equal(value.exists, false);
        assert.ok(
          reports.every(({ stage }) =>
            [
              "host",
              "system-policy-metadata",
              "system-policy-preflight-blocked",
            ].includes(stage),
          ),
          "no post-guard discovery or target launch",
        );
      } finally {
        Object.defineProperty(process, "platform", platform);
        Object.defineProperty(process, "arch", arch);
        process.argv = argv;
        console.log = log;
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });

test("standalone A/B validates at entry and again before every direct target spawn", async () => {
  const text = await source("mac-native-ab");
  const entry = text.slice(
    text.indexOf("export async function runRootDirectoryAB("),
  );
  const guard = entry.indexOf("await validateMacSystemPolicyReads();");
  assert.ok(guard >= 0, "standalone A/B missing system-policy preflight");
  assert.ok(guard < entry.indexOf("await nativeExecutable("));
  assert.match(
    entry,
    /await validateMacSystemPolicyReads\(\);\s*const result = await runBoundedProcess\(plan.request\);/,
  );
});

test(
  "standalone A/B rejects unknown system metadata before executable discovery",
  {
    skip: process.platform !== "linux",
  },
  async () => {
    await assert.rejects(validateMacSystemPolicyReads(), {
      code: "sandbox_unavailable",
    });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
    const reports: unknown[] = [];
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      Object.defineProperty(process, "arch", { value: "arm64" });
      await assert.rejects(
        runRootDirectoryAB(
          (...value) => {
            reports.push(value);
          },
          async () => {
            assert.fail("must not collect crashes without a launch");
          },
        ),
        { code: "sandbox_unavailable" },
      );
      assert.deepEqual(reports, []);
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
    }
  },
);

test("fixed metadata-only mode is strict and cannot dispatch a target", async () => {
  assert.deepEqual(
    diagnostics.diagnosticOptions(["--system-policy-metadata-only"]),
    {
      ab: false,
      only: undefined,
      help: false,
      policyMetadataOnly: true,
    },
  );
  for (const args of [
    ["--system-policy-metadata-only=/Users/private/config"],
    ["--system-policy-metadata-only", "--startup-only=node"],
  ])
    assert.throws(() => diagnostics.diagnosticOptions(args));
  const text = await source("macos-ai-diagnostics");
  const guard = text.indexOf("await validateMacSystemPolicyReads({");
  const stop = text.indexOf("if (policyMetadataOnly) return;");
  assert.ok(stop > guard && stop < text.indexOf("if (ab) {", guard));
});

test("metadata-only success exits without discovery, target spawn or host executable disclosure", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
  const argv = process.argv;
  const log = console.log;
  const reports: Array<{ stage: string; value: any }> = [];
  const spawn = t.mock.method(childProcess, "spawn", () => {
    throw new Error("forbidden child launch");
  });
  syncBuiltinESMExports();
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    Object.defineProperty(process, "arch", { value: "arm64" });
    process.argv = [argv[0], argv[1], "--system-policy-metadata-only"];
    console.log = (line: string) => reports.push(JSON.parse(line));
    await diagnostics.main({
      async lstat(path) {
        if (/\.(cnf|toml)$/.test(path))
          throw Object.assign(new Error("private"), { code: "ENOENT" });
        return {
          uid: 0,
          mode: 0o40755,
          isDirectory: () => path !== "/etc",
          isSymbolicLink: () => path === "/etc",
        };
      },
      async readlink(path) {
        assert.equal(path, "/etc");
        return "private/etc";
      },
      async readAcl() {
        return '{"version":1,"status":"empty"}\n';
      },
    });
    assert.equal(spawn.mock.callCount(), 0);
    assert.ok(
      reports.every(({ stage }) =>
        ["host", "system-policy-metadata"].includes(stage),
      ),
    );
    assert.equal("executable" in reports[0].value, false);
    assert.equal(
      reports.filter(({ value }) => value.exists === false).length,
      4,
    );
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process, "arch", arch);
    process.argv = argv;
    console.log = log;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

const source = (name: string) =>
  readFile(new URL(`../scripts/${name}.ts`, import.meta.url), "utf8");

test("diagnostic main awaits the real system-policy guard before any dispatch", async () => {
  const text = await source("macos-ai-diagnostics");
  const entry = text.slice(text.indexOf("async function main("));
  const guard = entry.indexOf("await validateMacSystemPolicyReads({");
  assert.ok(guard >= 0, "missing awaited real system-policy preflight");
  assert.ok(guard > entry.indexOf('process.platform !== "darwin"'));
  assert.ok(guard < entry.indexOf("if (ab)"), "A/B must not bypass preflight");
  assert.ok(guard < entry.indexOf("await metadata("));
  assert.match(text, /export async function main\(/);
});

// This is a real guard failure, not a replacement guard or configurable path.
// Linux lacks trusted macOS system ancestors. Simulate only the entry platform
// check to prove rejection exits before metadata, discovery, scratch or spawn.
for (const flag of [
  "--system-policy-metadata-only",
  "--startup-help-only=claude",
  "--startup-only=node",
  "--startup-ab-root-directory",
  undefined,
]) {
  test(
    `main propagates failed preflight without launching: ${flag ?? "full"}`,
    {
      skip: process.platform !== "linux",
    },
    async () => {
      await assert.rejects(validateMacSystemPolicyReads(), {
        code: "sandbox_unavailable",
      });
      assert.equal(
        typeof diagnostics.main,
        "function",
        "main must be testable",
      );
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const arch = Object.getOwnPropertyDescriptor(process, "arch")!;
      const argv = process.argv;
      const log = console.log;
      const reports: string[] = [];
      try {
        Object.defineProperty(process, "platform", { value: "darwin" });
        Object.defineProperty(process, "arch", { value: "arm64" });
        process.argv = [argv[0], argv[1], ...(flag ? [flag] : [])];
        console.log = (value: string) => {
          reports.push(value);
        };
        await assert.rejects(diagnostics.main(), {
          code: "sandbox_unavailable",
        });
        assert.deepEqual(
          reports.map((line) => JSON.parse(line).stage),
          ["host", "system-policy-metadata", "system-policy-preflight-blocked"],
        );
      } finally {
        Object.defineProperty(process, "platform", platform);
        Object.defineProperty(process, "arch", arch);
        process.argv = argv;
        console.log = log;
      }
    },
  );
}
