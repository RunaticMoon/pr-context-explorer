// Credential-free reproduction only. Never read settings, key files or parent env.
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { runBoundedProcess } from "../src/server/ai/runner.ts";
import {
  lstat,
  mkdtemp,
  realpath,
  readdir,
  rm,
  open,
  opendir,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, basename } from "node:path";
import { release, userInfo } from "node:os";
import {
  buildSeatbeltProfile,
  validateMacSystemPolicyReads,
} from "../src/server/ai/macos.ts";
import {
  macLayout,
  runSeatbeltCommand,
  probeMacSandbox,
} from "../src/server/ai/macos-runtime.ts";
import { nativeExecutable } from "../src/server/ai/sandbox.ts";
import { resolveMacEngine } from "../src/server/ai/macos-discovery.ts";
import { probeCli } from "../src/server/ai/probes.ts";

// JSON escapes control characters (including terminal/GitHub workflow commands).
const report = (stage: string, value: unknown) =>
  console.log(JSON.stringify({ stage, value }));
const errorCode = (e: unknown) => ({
  code: (e as NodeJS.ErrnoException).code ?? "diagnostic_failed",
});

const MAX_IPS_BYTES = 2 * 1024 * 1024;
// Already covers the ~350ms caller/unified-log offset in run 34932821826.
const CRASH_CLOCK_TOLERANCE_MS = 1000;
type CrashRejection = {
  reason: "payload_too_large" | "invalid_json" | "identity_or_time_mismatch";
  pidMatches?: boolean;
  executableMatches?: boolean;
  launchDeltaMs?: number | null;
  captureDeltaMs?: number | null;
  reportedIdentity?: {
    procPath?: string;
    pathHasRedactionMarker: boolean;
    reportType?: string;
    fieldTypes: Record<string, string>;
  };
  hypothesis?: {
    status: "unverified-executable-match";
    exception: ReturnType<typeof fields>;
    termination: ReturnType<typeof terminationFields>;
    faultingSymbols: string[];
  };
};
interface CrashScope {
  pid: number;
  executable: string;
  startedAt: number;
  endedAt: number;
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown, max = 512) =>
  typeof v === "string"
    ? v.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, " ")
    : undefined;
const fields = (v: unknown, keys: string[]) =>
  Object.fromEntries(
    keys.flatMap<[string, string | number | undefined]>((key) => {
      const value = record(v)[key];
      return typeof value === "string"
        ? [[key, text(value)]]
        : typeof value === "number" && Number.isFinite(value)
          ? [[key, value]]
          : [];
    }),
  );
const terminationFields = (v: unknown) => ({
  ...fields(v, ["namespace", "code", "indicator", "byProc", "byPid"]),
  ...Object.fromEntries(
    ["details", "reasons"].map((key) => {
      const value = record(v)[key];
      return [
        key,
        (Array.isArray(value) ? value : [value])
          .slice(0, 4)
          // Missing/non-string values must not serialize as invented nulls.
          // Never recurse into objects or nested arrays from a native report.
          .flatMap((item) =>
            typeof item === "string" ? [text(item, 1024)!] : [],
          ),
      ];
    }),
  ),
});
const crashTime = (v: unknown) =>
  typeof v === "string"
    ? Date.parse(
        v.replace(
          /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d(?:\.\d+)?) ([+-]\d\d)(\d\d)$/,
          "$1T$2$3:$4",
        ),
      )
    : NaN;

/** Parse only data, never evaluate crash contents. No environment, registers,
 * memory maps, command lines, or entire report is returned. Exported for tests. */
export function summarizeCrash(
  raw: string,
  scope: CrashScope,
  reject?: (value: CrashRejection) => void,
) {
  if (Buffer.byteLength(raw) > MAX_IPS_BYTES) {
    reject?.({ reason: "payload_too_large" });
    return;
  }
  try {
    let body: Record<string, unknown>;
    let header: Record<string, unknown> = {};
    try {
      body = record(JSON.parse(raw));
    } catch {
      const newline = raw.indexOf("\n");
      body = record(JSON.parse(raw.slice(newline + 1)));
      // Header metadata is optional and never supplies process identity.
      try {
        header = record(JSON.parse(raw.slice(0, newline)));
      } catch {}
    }
    const launch = crashTime(body.procLaunch),
      capture = crashTime(body.captureTime);
    const timeMatches =
      Number.isFinite(launch) &&
      Number.isFinite(capture) &&
      launch >= scope.startedAt - CRASH_CLOCK_TOLERANCE_MS &&
      launch <= scope.endedAt + CRASH_CLOCK_TOLERANCE_MS &&
      capture >= scope.startedAt - CRASH_CLOCK_TOLERANCE_MS &&
      capture <= scope.endedAt + CRASH_CLOCK_TOLERANCE_MS;
    if (
      body.pid !== scope.pid ||
      body.procPath !== scope.executable ||
      !timeMatches
    ) {
      // Only PID+time-correlated candidates may expose diagnostic text. A
      // redacted/missing/different path NEVER becomes a verified target report.
      const correlated = body.pid === scope.pid && timeMatches;
      const reportType = body.bug_type ?? header.bug_type;
      reject?.({
        ...(correlated
          ? {
              reportedIdentity: {
                // Observed marker, not proof of Apple's redaction or identity.
                pathHasRedactionMarker:
                  typeof body.procPath === "string" &&
                  (body.procPath.startsWith("/Users/USER/") ||
                    body.procPath.includes("*")),
                procPath:
                  typeof body.procPath === "string"
                    ? text(
                        body.procPath.replace(
                          /^\/Users\/[^/]+\//,
                          "/Users/USER/",
                        ),
                        256,
                      )
                    : undefined,
                reportType: /^(?:\d{1,4})$/.test(String(reportType))
                  ? String(reportType)
                  : undefined,
                fieldTypes: Object.fromEntries(
                  [
                    "procPath",
                    "procName",
                    "pid",
                    "procLaunch",
                    "captureTime",
                    "bug_type",
                    "exception",
                    "termination",
                    "asi",
                    "usedImages",
                  ].map((key) => [
                    key,
                    !Object.hasOwn(body, key)
                      ? "missing"
                      : body[key] === null
                        ? "null"
                        : Array.isArray(body[key])
                          ? "array"
                          : typeof body[key],
                  ]),
                ),
              },
              hypothesis: {
                status: "unverified-executable-match" as const,
                exception: fields(body.exception, [
                  "type",
                  "signal",
                  "subtype",
                  "codes",
                ]),
                termination: terminationFields(body.termination),
                // Independent diagnostic channel when reason text is absent:
                // symbols only, never image addresses, offsets or thread state.
                faultingSymbols: (() => {
                  const threads = Array.isArray(body.threads)
                    ? body.threads
                    : [];
                  const index = body.faultingThread;
                  const thread = record(
                    (typeof index === "number" &&
                    Number.isSafeInteger(index) &&
                    index >= 0
                      ? threads[index]
                      : undefined) ??
                      threads.find((t) => record(t).triggered === true),
                  );
                  return (Array.isArray(thread.frames) ? thread.frames : [])
                    .slice(0, 16)
                    .flatMap((f) => {
                      const symbol = text(record(f).symbol);
                      return symbol === undefined ? [] : [symbol];
                    });
                })(),
              },
            }
          : {}),
        reason: "identity_or_time_mismatch",
        pidMatches: body.pid === scope.pid,
        executableMatches: body.procPath === scope.executable,
        launchDeltaMs: Number.isFinite(launch)
          ? launch - scope.startedAt
          : null,
        captureDeltaMs: Number.isFinite(capture)
          ? capture - scope.startedAt
          : null,
      });
      return;
    }
    const threads = Array.isArray(body.threads) ? body.threads : [];
    const thread = record(
      threads[Number(body.faultingThread)] ??
        threads.find((t) => record(t).triggered === true),
    );
    const frames = Array.isArray(thread.frames)
      ? thread.frames.slice(0, 16)
      : [];
    const images = Array.isArray(body.usedImages) ? body.usedImages : [];
    return {
      pid: scope.pid,
      executable: scope.executable,
      procLaunch: text(body.procLaunch),
      captureTime: text(body.captureTime),
      exception: fields(body.exception, ["type", "signal", "subtype", "codes"]),
      termination: terminationFields(body.termination),
      asi: Object.entries(record(body.asi))
        .slice(0, 4)
        .map(([image, messages]) => ({
          image: text(image, 128),
          messages: (Array.isArray(messages) ? messages : [messages])
            .slice(0, 4)
            .map((m) => text(m, 1024)),
        })),
      frames: frames.map((f) => ({
        ...fields(f, ["symbol", "symbolLocation", "imageIndex", "imageOffset"]),
        image: text(record(images[Number(record(f).imageIndex)]).name, 128),
      })),
    };
  } catch {
    reject?.({ reason: "invalid_json" });
    return;
  }
}

/** Test seam only; the CLI supplies paths solely from fixed report directories. */
export async function readCrashCandidate(
  path: string,
  scope: CrashScope,
  reject?: (
    value: Omit<CrashRejection, "reason"> & {
      reason: CrashRejection["reason"] | "file_metadata_rejected";
      sizeBytes: number;
      mtimeDeltaMs: number;
    },
  ) => void,
) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    const candidate = {
      sizeBytes: stat.size,
      mtimeDeltaMs: stat.mtimeMs - scope.startedAt,
    };
    if (
      !stat.isFile() ||
      stat.mtimeMs < scope.startedAt ||
      stat.mtimeMs > Date.now() + 1000 ||
      stat.size <= 0 ||
      stat.size > MAX_IPS_BYTES
    ) {
      reject?.({ reason: "file_metadata_rejected", ...candidate });
      return;
    }
    // Fixed buffer rather than readFile: a growing file cannot evade cap.
    const buffer = Buffer.alloc(MAX_IPS_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    return summarizeCrash(
      buffer.subarray(0, length).toString("utf8"),
      scope,
      (value) => reject?.({ ...value, ...candidate }),
    );
  } finally {
    await handle.close();
  }
}

async function collectCrashes(name: string, scope: CrashScope) {
  // Account database home, not parent environment. Fixed report directories only.
  const directories = [
    `${userInfo().homedir}/Library/Logs/DiagnosticReports`,
    "/Library/Logs/DiagnosticReports",
  ];
  const seen = new Set<string>();
  let reads = 0,
    matches = 0;
  const deadline = Date.now() + 8000;
  for (let attempt = 0; attempt < 5 && Date.now() < deadline; attempt++) {
    for (const directory of directories) {
      try {
        const ds = await lstat(directory);
        if (!ds.isDirectory() || ds.isSymbolicLink()) continue;
        const dir = await opendir(directory);
        let scanned = 0;
        for await (const entry of dir) {
          if (
            ++scanned > 2048 ||
            reads >= 24 ||
            matches >= 3 ||
            Date.now() >= deadline
          )
            break;
          // Do not read unrelated crash payloads. PID is verified inside the IPS;
          // filenames do not reliably include it on macOS.
          if (
            !entry.isFile() ||
            !entry.name.endsWith(".ips") ||
            !["-", "_"].some((separator) =>
              entry.name.startsWith(
                `${basename(scope.executable)}${separator}`,
              ),
            )
          )
            continue;
          const path = `${directory}/${entry.name}`;
          if (seen.has(path)) continue;
          try {
            const stat = await lstat(path);
            if (!stat.isFile() || stat.mtimeMs < scope.startedAt) continue;
            reads++;
            const summary = await readCrashCandidate(path, scope, (rejection) =>
              // At most 24 records; correlated text is bounded and unverified.
              report(`${name}-crash-candidate-rejected`, {
                attempt,
                read: reads,
                ...rejection,
              }),
            );
            if (summary) {
              seen.add(path);
              matches++;
              report(`${name}-fresh-crash-summary`, summary);
            }
          } catch (e) {
            report(`${name}-crash-candidate-error`, errorCode(e));
          }
        }
      } catch (e) {
        report(`${name}-crash-directory-error`, { directory, ...errorCode(e) });
      }
    }
    if (matches || reads >= 24) break;
    if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  report(`${name}-crash-search`, {
    ...scope,
    matches,
    reads,
    maxReads: 24,
    maxBytesPerFile: MAX_IPS_BYTES,
    status: matches
      ? "matched"
      : "no_matching_fresh_report_not_proof_of_no_crash",
  });
}

async function metadata(path: string) {
  for (let p = path; ; p = dirname(p)) {
    try {
      const s = await lstat(p);
      report("path-metadata", {
        path: p,
        realpath: await realpath(p),
        uid: s.uid,
        gid: s.gid,
        mode: (s.mode & 0o7777).toString(8),
        symlink: s.isSymbolicLink(),
        directory: s.isDirectory(),
      });
    } catch (e) {
      report("path-metadata-error", { path: p, ...errorCode(e) });
    }
    if (p === dirname(p)) break;
  }
}

export function startupOnlyTarget(
  args: string[],
): "node" | "codex" | "claude" | undefined {
  if (!args.length) return;
  const target = args[0].replace(/^--startup-only=/, "");
  if (
    args.length !== 1 ||
    !args[0].startsWith("--startup-only=") ||
    (target !== "node" && target !== "codex" && target !== "claude")
  )
    throw new Error(
      "Expected --startup-only=node|codex|claude or no arguments",
    );
  return target;
}

export function startupABRootDirectory(args: string[]): boolean {
  if (args.length === 1 && args[0] === "--startup-ab-root-directory")
    return true;
  startupOnlyTarget(args); // Same strict rejection for unknown/combined flags.
  return false;
}

export function diagnosticOptions(args: string[]) {
  if (args.length === 1 && args[0] === "--startup-help-only=claude")
    return { ab: false, only: "claude" as const, help: true };
  const ab = startupABRootDirectory(args);
  return { ab, only: ab ? undefined : startupOnlyTarget(args), help: false };
}

/** Fixed startup arguments only; no auth, schema, proxy or ambient env input. */
export function startupCommandInput(
  executable: string,
  scratch: string,
  target: string,
  help: boolean,
): Parameters<typeof runSeatbeltCommand>[0] {
  if (help && target !== "claude") throw new Error("Claude help only");
  return {
    executablePath: executable,
    scratch,
    args: help
      ? ["--help"]
      : target === "node"
        ? [
            "-e",
            "require('node:fs').writeFileSync('fake-scratch','ok');console.log(JSON.stringify({started:true,cwd:process.cwd(),pid:process.pid}));",
          ]
        : ["--version"],
    process: {
      deadlineMs: 10000,
      maxStdoutBytes: 65536,
      maxStderrBytes: 65536,
      maxTotalBytes: 131072,
    },
  };
}

export async function main() {
  const { ab, only, help } = diagnosticOptions(process.argv.slice(2));
  report("host", {
    platform: process.platform,
    arch: process.arch,
    release: release(),
    node: process.version,
    executable: process.execPath,
  });
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    report(
      "unsupported",
      "This must execute on real Darwin arm64; Linux output is not Seatbelt verification.",
    );
    process.exitCode = 1;
    return;
  }
  // Profile construction is not launch authorization. Refuse unsupported or
  // unknown system policy before discovery, diagnostics, or direct A/B spawns.
  await validateMacSystemPolicyReads();
  if (ab) {
    const { runRootDirectoryAB } = await import("./mac-native-ab.ts");
    await runRootDirectoryAB(report, collectCrashes);
    return; // Never capabilities, auth, inference, or a fallback profile.
  }
  // Metadata only: do not grant these paths merely because they exist.
  for (const path of [
    "/usr/lib/dyld",
    "/System/Library/dyld",
    "/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld",
    "/System/Cryptexes/OS/System/Library/dyld",
  ]) {
    await metadata(path);
    try {
      const entries = (await readdir(path))
        .filter((n) => /^dyld_shared_cache_[A-Za-z0-9_.]+$/.test(n))
        .sort();
      report("runtime-directory", {
        path,
        total: entries.length,
        shown: Math.min(entries.length, 24),
      });
      for (const name of entries.slice(0, 24))
        await metadata(`${path}/${name}`);
    } catch (e) {
      report("runtime-directory-error", { path, ...errorCode(e) });
    }
  }
  await metadata("/tmp");
  await metadata("/usr/bin/sandbox-exec");
  await metadata("/etc/ssl/cert.pem");
  const targets: Array<{ name: string; path: string }> = [
    ...(!only || only === "node"
      ? [{ name: "node", path: process.execPath }]
      : []),
  ];
  for (const provider of ["codex", "claude"] as const) {
    if (only && only !== provider) continue;
    try {
      targets.push({ name: provider, path: await resolveMacEngine(provider) });
    } catch (e) {
      report(`${provider}-discovery-error`, errorCode(e));
      process.exitCode = 1;
    }
  }
  for (const target of targets) {
    await metadata(target.path);
    const scratch = await realpath(await mkdtemp("/tmp/ai-diagnostic-"));
    try {
      const executable = await nativeExecutable(target.path);
      const dirs = await macLayout(scratch);
      // Same generator, paths and no-network inputs used by runSeatbeltCommand.
      const profile = buildSeatbeltProfile({
        executable,
        writable: Object.values(dirs).filter((p) => p !== dirs.root),
        readOnly: [],
      });
      report(`${target.name}-exact-profile`, profile);
      report(
        `${target.name}-numbered-profile`,
        profile.split("\n").map((line, i) => `${i + 1}: ${line}`),
      );
      const input = startupCommandInput(executable, scratch, target.name, help);
      const sha256 = createHash("sha256").update(profile).digest("hex");
      report(`${target.name}-startup-contract`, {
        mode: help ? "startup-help-only" : "startup",
        args: input.args,
        sha256,
        cwd: dirs.work,
        credentials: "none_fresh_private_home_and_config_no_parent_env",
        inference: false,
        runtimeVerified: false,
      });
      const startedAt = Date.now();
      const result = await runSeatbeltCommand(input);
      const endedAt = Date.now();
      report(`${target.name}-credential-free-startup`, {
        args: input.args,
        sha256,
        startedAt,
        endedAt,
        executable,
        ...result,
      });
      if (result.exitCode !== 0) process.exitCode = 1;
      // Inspect the SAME production-profile launch, not a second compiler PID.
      const pid = result.pid;
      if (pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
        if (result.exitCode !== 0)
          await collectCrashes(target.name, {
            pid,
            executable,
            startedAt,
            endedAt,
          });
        const predicate = `(processIdentifier == ${pid}) OR ((process == "kernel" OR process == "sandboxd" OR process == "ReportCrash" OR process == "amfid" OR process == "syspolicyd") AND (eventMessage CONTAINS "(${pid})" OR eventMessage CONTAINS "[${pid}]" OR eventMessage CONTAINS "pid ${pid} " OR eventMessage CONTAINS "pid: ${pid},"))`;
        report(`${target.name}-os-log-scope`, {
          targetPid: pid,
          executable,
          startedAt,
          endedAt,
          sha256,
          last: "2m",
          predicate,
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
          report(`${target.name}-sandbox-crash-log`, {
            ...logs,
            logReaderPid: logs.pid,
            targetPid: pid,
            sha256,
            status:
              logs.exitCode === 0 && logs.stdout.trim()
                ? "captured_requires_pid_and_launch_time_review"
                : "unavailable_or_empty_not_proof_of_no_denial",
          });
        } catch (e) {
          report(`${target.name}-sandbox-crash-log-error`, errorCode(e));
        }
      }
    } catch (e) {
      report(`${target.name}-startup-error`, errorCode(e));
      process.exitCode = 1;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  // One unchanged-profile launch only; no repeated capability/confinement aborts.
  if (only) return;
  const confinement = await probeMacSandbox({
    runtimeNodePath: process.execPath,
  });
  report("actual-confinement", confinement);
  if (!confinement.available || !confinement.runtimeVerified)
    process.exitCode = 1;
  for (const provider of ["codex", "claude"] as const) {
    const result = await probeCli(provider, {}, undefined, (args, result) =>
      report(`${provider}-credential-free-command`, { args, ...result }),
    );
    report(`${provider}-capabilities`, result);
    if (
      !result.capabilities.supported ||
      result.emptyAuthStatus !== "not_authenticated"
    )
      process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main().catch((e) => {
    report("fatal", errorCode(e));
    process.exitCode = 1;
  });
