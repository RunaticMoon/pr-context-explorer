import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

async function runFixtures(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    timedOut = false;
  const killOwnedRunner = () => {
    if (child.pid) {
      if (process.platform === "win32") child.kill("SIGKILL");
      else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    killOwnedRunner();
  }, 30000);
  try {
    const status = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(
      timedOut,
      false,
      "fixture runner timed out\n" + stdout + stderr,
    );
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
    // Also reap descendants after a runner failure, not just the direct child.
    killOwnedRunner();
  }
}

// Reproduce macOS /tmp -> /private/tmp on any supported POSIX test host.
// Run the actual fixture setup and its existing malicious-symlink assertions;
// resolving arbitrary caller-supplied store/settings paths is NOT the fix.
test("store, settings, desktop and simple connection fixtures work beneath an aliased system temp directory", async (t) => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "prce-tmp-alias-")),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const alias = path.join(root, "tmp-alias");
  symlinkSync(root, alias, "dir");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: alias,
    TMP: alias,
    TEMP: alias,
  };
  // A nested Node test runner must not inherit its parent's worker context.
  delete env.NODE_TEST_CONTEXT;
  const result = await runFixtures(
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      "--test-concurrency=2",
      "tests/store.test.ts",
      "tests/settings.test.ts",
      "tests/desktop-runtime.test.ts",
      "tests/engine-session-auth.test.ts",
      "tests/engine-setup.test.ts",
      "tests/github-simple.test.ts",
      "tests/jira-onboarding-routes.test.ts",
      "tests/jira-onboarding-tls.test.ts",
      "tests/simple-credential-lifecycle.test.ts",
      "tests/simple-setup-integration.test.ts",
    ],
    env,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // Exit zero alone is insufficient: inherited NODE_TEST_CONTEXT used to make
  // nested runners silently skip their files. Require actual, unskipped cases.
  for (const name of [
    "session auth API uses exact shapes, generic errors and rejects active-job changes",
    "close cancels a paused token probe without resurrecting files or readiness",
    "discovery exposes installed independently of compatibility; consent alone wires auth",
    "simple PAT onboarding discovers identity and retains only session credentials",
    "real source route registers derived connection and settings remain secret-free, delete revokes binding",
    "HTTPS onboarding -> secret-free persisted mapping -> authenticated issue capture; TLS/redirect/auth failures closed",
    "real HTTPS Jira revocation aborts response wait and emits no subsequent Authorization",
    "LiveAPI shutdown prevents a paused executor from writing pipeline cache or completing a job",
    "engine setup is a real authenticated HTTP route with strict CSRF and JSON boundaries",
  ]) {
    assert.ok(
      result.stdout
        .split("\n")
        .some((line) => /^ok \d+ - /.test(line) && line.endsWith(` - ${name}`)),
      `nested runner did not execute: ${name}\n${result.stdout}${result.stderr}`,
    );
  }
});
