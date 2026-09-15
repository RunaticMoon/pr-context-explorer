import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as diagnostics from "../scripts/macos-ai-diagnostics.ts";
import { runRootDirectoryAB } from "../scripts/mac-native-ab.ts";
import { validateMacSystemPolicyReads } from "../src/server/ai/macos.ts";

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

const source = (name: string) =>
  readFile(new URL(`../scripts/${name}.ts`, import.meta.url), "utf8");

test("diagnostic main awaits the real system-policy guard before any dispatch", async () => {
  const text = await source("macos-ai-diagnostics");
  const entry = text.slice(text.indexOf("async function main("));
  const guard = entry.indexOf("await validateMacSystemPolicyReads();");
  assert.ok(guard >= 0, "missing awaited system-policy preflight");
  assert.ok(guard > entry.indexOf('process.platform !== "darwin"'));
  assert.ok(guard < entry.indexOf("if (ab)"), "A/B must not bypass preflight");
  assert.ok(guard < entry.indexOf("await metadata("));
  assert.match(text, /export async function main\(/);
});

// This is a real guard failure, not a replacement guard or configurable path.
// Linux lacks trusted macOS system ancestors. Simulate only the entry platform
// check to prove rejection exits before metadata, discovery, scratch or spawn.
for (const flag of [
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
          ["host"],
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
