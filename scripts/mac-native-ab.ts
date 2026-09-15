// Test-script-only experiment. No production profile override or inference entry.
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, lstat, readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { buildSeatbeltProfile } from "../src/server/ai/macos.ts";
import { macLayout } from "../src/server/ai/macos-runtime.ts";
import {
  cleanEnvironment,
  nativeExecutable,
} from "../src/server/ai/sandbox.ts";
import { resolveMacEngine } from "../src/server/ai/macos-discovery.ts";
import {
  runBoundedProcess,
  type ProcessRequest,
} from "../src/server/ai/runner.ts";

const RULE = '(allow file-read-data (literal "/"))';
type Dirs = Awaited<ReturnType<typeof macLayout>>;
export function rootDirectoryABPlans(executable: string, dirs: Dirs) {
  const baseline = buildSeatbeltProfile({
    executable,
    writable: Object.values(dirs).filter((p) => p !== dirs.root),
    readOnly: [],
  });
  const env = {
    ...cleanEnvironment(),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    CODEX_HOME: dirs.codex,
    CLAUDE_CONFIG_DIR: dirs.claude,
    PATH: "/nonexistent",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
    NODE_EXTRA_CA_CERTS: "/private/etc/ssl/cert.pem",
  };
  return (["baseline", "literal-root-directory"] as const).map((variant) => {
    const profile = variant === "baseline" ? baseline : `${baseline}\n${RULE}`;
    const request: ProcessRequest = {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, executable, "--version"],
      cwd: dirs.work,
      env: { ...env },
      deadlineMs: 10000,
      maxStdoutBytes: 65536,
      maxStderrBytes: 65536,
      maxTotalBytes: 131072,
    };
    return {
      variant,
      profile,
      sha256: createHash("sha256").update(profile).digest("hex"),
      request,
    };
  });
}

export async function runRootDirectoryAB(
  report: (stage: string, value: unknown) => void,
  crashes: (
    name: string,
    scope: {
      pid: number;
      executable: string;
      startedAt: number;
      endedAt: number;
    },
  ) => Promise<void>,
) {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Darwin arm64 required");
  const sandbox = await nativeExecutable("/usr/bin/sandbox-exec");
  if (sandbox !== "/usr/bin/sandbox-exec" || (await lstat(sandbox)).uid !== 0)
    throw new Error("untrusted sandbox");
  const executable = await nativeExecutable(await resolveMacEngine("claude"));
  const ca = await realpath("/etc/ssl/cert.pem");
  const stat = await lstat(ca);
  if (
    ca !== "/private/etc/ssl/cert.pem" ||
    !stat.isFile() ||
    stat.uid !== 0 ||
    stat.mode & 0o022 ||
    stat.size > 4 * 1024 * 1024
  )
    throw new Error("invalid CA");
  createSecureContext({ ca: await readFile(ca, "utf8") });
  const scratch = await realpath(await mkdtemp("/tmp/ai-startup-ab-"));
  try {
    const dirs = await macLayout(scratch);
    const plans = rootDirectoryABPlans(executable, dirs);
    report("startup-ab-contract", {
      target: "claude",
      executable,
      args: ["--version"],
      cwd: dirs.work,
      addedRule: RULE,
      removedRules: [],
      productionChanged: false,
      runtimeVerified: false,
    });
    const outcomes: unknown[] = [];
    for (const plan of plans) {
      // Same absolute paths, but no state carries from A into B. Only app-owned dirs.
      for (const path of Object.values(dirs).filter((p) => p !== dirs.root))
        await rm(path, { recursive: true, force: true });
      await macLayout(scratch);
      const name = `claude-startup-ab-${plan.variant}`;
      report(`${name}-exact-profile`, {
        variant: plan.variant,
        sha256: plan.sha256,
        profile: plan.profile,
      });
      const startedAt = Date.now();
      try {
        const result = await runBoundedProcess(plan.request);
        const endedAt = Date.now();
        report(`${name}-result`, {
          variant: plan.variant,
          sha256: plan.sha256,
          executable,
          startedAt,
          endedAt,
          ...result,
        });
        outcomes.push({
          variant: plan.variant,
          sha256: plan.sha256,
          exitCode: result.exitCode,
          terminationSignal: result.terminationSignal,
          pid: result.pid,
        });
        if (result.pid && Number.isSafeInteger(result.pid)) {
          if (result.exitCode !== 0)
            await crashes(name, {
              pid: result.pid,
              executable,
              startedAt,
              endedAt,
            });
          const predicate = `(processIdentifier == ${result.pid}) OR ((process == "kernel" OR process == "sandboxd" OR process == "ReportCrash") AND (eventMessage CONTAINS "(${result.pid})" OR eventMessage CONTAINS "[${result.pid}]" OR eventMessage CONTAINS "pid ${result.pid} " OR eventMessage CONTAINS "pid: ${result.pid},"))`;
          try {
            const logs = await runBoundedProcess({
              executable: "/usr/bin/log",
              args: [
                "show",
                "--last",
                "2m",
                "--style",
                "ndjson",
                "--info",
                "--debug",
                "--predicate",
                predicate,
              ],
              cwd: dirs.work,
              env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
              deadlineMs: 10000,
              maxStdoutBytes: 65536,
              maxStderrBytes: 4096,
            });
            report(`${name}-os-log`, {
              variant: plan.variant,
              sha256: plan.sha256,
              ...logs,
              logReaderPid: logs.pid,
              pid: result.pid,
              predicate,
            });
          } catch {
            report(`${name}-os-log`, {
              status: "unavailable_not_proof_of_no_denial",
            });
          }
        }
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "probe_failed";
        report(`${name}-error`, {
          variant: plan.variant,
          sha256: plan.sha256,
          code,
        });
        outcomes.push({ variant: plan.variant, code });
      }
    }
    report("startup-ab-outcomes", {
      outcomes,
      runtimeVerified: false,
      interpretation: "experiment_only_not_a_fix_or_boundary_verification",
    });
    // Even B success must not turn this diagnostic into a production readiness gate.
    process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
