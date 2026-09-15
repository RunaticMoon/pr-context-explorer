// Test-script-only experiment. No production profile override or inference entry.
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, lstat, readFile } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import {
  buildSeatbeltProfile,
  validateMacSystemPolicyReads,
} from "../src/server/ai/macos.ts";
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
const ICU_FILE = "/usr/share/icu/icudt76l.dat";
const ICU_RULE =
  '(allow file-read-data file-read-metadata (literal "/usr/share/icu/icudt76l.dat"))';
const MODES = {
  root: {
    rule: RULE,
    variant: "literal-root-directory",
    argument: "--version",
    stage: "startup-ab",
  },
  icu: {
    rule: ICU_RULE,
    variant: "literal-icu-file",
    argument: "--help",
    stage: "startup-ab-icu-file",
  },
} as const;
type Mode = keyof typeof MODES;
type Dirs = Awaited<ReturnType<typeof macLayout>>;
export function rootDirectoryABPlans(executable: string, dirs: Dirs) {
  return startupABPlans(executable, dirs, "root");
}
export function icuFileABPlans(executable: string, dirs: Dirs) {
  return startupABPlans(executable, dirs, "icu");
}
function startupABPlans(executable: string, dirs: Dirs, mode: Mode) {
  const experiment = MODES[mode];
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
  return (["baseline", experiment.variant] as const).map((variant) => {
    const profile =
      variant === "baseline" ? baseline : `${baseline}\n${experiment.rule}`;
    const request: ProcessRequest = {
      executable: "/usr/bin/sandbox-exec",
      args: ["-p", profile, executable, experiment.argument],
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

type Reporter = (stage: string, value: unknown) => void;
/** Fixed leaf only, no readlink/realpath/content access. Test seam is code-only. */
export async function validateIcuFileMetadata(
  report: Reporter,
  inspect: (
    path: string,
  ) => Promise<{
    uid: number;
    mode: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }> = lstat,
) {
  let stat;
  try {
    stat = await inspect(ICU_FILE);
  } catch (error) {
    report("startup-ab-icu-file-host-metadata", {
      path: ICU_FILE,
      exists:
        (error as NodeJS.ErrnoException).code === "ENOENT" ? false : "unknown",
      accepted: false,
    });
    throw new Error(
      "ICU fixed-file metadata unavailable; stop, do not broaden",
    );
  }
  const accepted =
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === 0 &&
    !(stat.mode & 0o022);
  report("startup-ab-icu-file-host-metadata", {
    path: ICU_FILE,
    exists: true,
    uid: stat.uid,
    mode: (stat.mode & 0o7777).toString(8),
    fileType: stat.isSymbolicLink()
      ? "symlink"
      : stat.isFile()
        ? "regular"
        : "other",
    accepted,
  });
  if (!accepted)
    throw new Error("ICU fixed-file metadata rejected; stop, do not broaden");
}

export async function runRootDirectoryAB(
  report: Reporter,
  crashes: Parameters<typeof runStartupAB>[1],
) {
  return runStartupAB(report, crashes, "root");
}
export function runIcuFileAB(
  report: Reporter,
  crashes: Parameters<typeof runStartupAB>[1],
) {
  return runStartupAB(report, crashes, "icu");
}
async function runStartupAB(
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
  mode: Mode,
) {
  if (mode === "icu") process.exitCode = 1; // Even preflight errors: never readiness.
  const experiment = MODES[mode];
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Darwin arm64 required");
  // Standalone callers must not bypass the diagnostic main's host preflight.
  await validateMacSystemPolicyReads();
  if (mode === "icu") await validateIcuFileMetadata(report);
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
    const plans = startupABPlans(executable, dirs, mode);
    report(`${experiment.stage}-contract`, {
      target: "claude",
      executable,
      args: [experiment.argument],
      cwd: dirs.work,
      addedRule: experiment.rule,
      credentials: "none_fresh_private_home_and_config_no_parent_env",
      inference: false,
      deadlineMs: 10000,
      maxTotalBytes: 131072,
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
      const name = `claude-${experiment.stage}-${plan.variant}`;
      report(`${name}-exact-profile`, {
        variant: plan.variant,
        sha256: plan.sha256,
        profile: plan.profile,
      });
      const startedAt = Date.now();
      try {
        if (mode === "icu") await validateIcuFileMetadata(report);
        // Plans only construct profiles: recheck host policy for EACH launch.
        await validateMacSystemPolicyReads();
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
          const predicate = `(processIdentifier == ${result.pid}) OR ((process == "kernel" OR process == "sandboxd" OR process == "ReportCrash" OR process == "amfid" OR process == "syspolicyd") AND (eventMessage CONTAINS "(${result.pid})" OR eventMessage CONTAINS "[${result.pid}]" OR eventMessage CONTAINS "pid ${result.pid} " OR eventMessage CONTAINS "pid: ${result.pid},"))`;
          report(`${name}-os-log-scope`, {
            targetPid: result.pid,
            executable,
            startedAt,
            endedAt,
            sha256: plan.sha256,
            predicate,
            last: "2m",
            attribution:
              "target_pid_or_system_message_pid_requires_launch_time_correlation",
          });
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
              targetPid: result.pid,
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
        if (mode === "icu") break; // Unknown metadata/launch error: stop, no fallback.
      }
    }
    report(`${experiment.stage}-outcomes`, {
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
