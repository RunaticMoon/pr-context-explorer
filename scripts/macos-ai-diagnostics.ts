// Credential-free reproduction only. Never read settings, key files or parent env.
import { pathToFileURL } from "node:url";
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
import { buildSeatbeltProfile } from "../src/server/ai/macos.ts";
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
export function summarizeCrash(raw: string, scope: CrashScope) {
  if (Buffer.byteLength(raw) > MAX_IPS_BYTES) return;
  try {
    let body: Record<string, unknown>;
    try {
      body = record(JSON.parse(raw));
    } catch {
      body = record(JSON.parse(raw.slice(raw.indexOf("\n") + 1)));
    }
    const launch = crashTime(body.procLaunch),
      capture = crashTime(body.captureTime);
    if (
      body.pid !== scope.pid ||
      body.procPath !== scope.executable ||
      !Number.isFinite(launch) ||
      !Number.isFinite(capture) ||
      launch < scope.startedAt - 1000 ||
      launch > scope.endedAt + 1000 ||
      capture < scope.startedAt - 1000 ||
      capture > scope.endedAt + 1000
    )
      return;
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
      termination: {
        ...fields(body.termination, [
          "namespace",
          "code",
          "indicator",
          "byProc",
          "byPid",
        ]),
        ...Object.fromEntries(
          ["details", "reasons"].map((key) => {
            const value = record(body.termination)[key];
            return [
              key,
              (Array.isArray(value) ? value : [value])
                .slice(0, 4)
                .map((v) => text(v, 1024)),
            ];
          }),
        ),
      },
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
    return;
  }
}

/** Test seam only; the CLI supplies paths solely from fixed report directories. */
export async function readCrashCandidate(path: string, scope: CrashScope) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.mtimeMs < scope.startedAt ||
      stat.mtimeMs > Date.now() + 1000 ||
      stat.size <= 0 ||
      stat.size > MAX_IPS_BYTES
    )
      return;
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
    return summarizeCrash(buffer.subarray(0, length).toString("utf8"), scope);
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
            const summary = await readCrashCandidate(path, scope);
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

async function main() {
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
    { name: "node", path: process.execPath },
  ];
  for (const provider of ["codex", "claude"] as const) {
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
      const args =
        target.name === "node"
          ? [
              "-e",
              "require('node:fs').writeFileSync('fake-scratch','ok');console.log(JSON.stringify({started:true,cwd:process.cwd(),pid:process.pid}));",
            ]
          : ["--version"];
      const startedAt = Date.now();
      const result = await runSeatbeltCommand({
        executablePath: executable,
        args,
        scratch,
        process: {
          deadlineMs: 10000,
          maxStdoutBytes: 65536,
          maxStderrBytes: 65536,
        },
      });
      const endedAt = Date.now();
      report(`${target.name}-credential-free-startup`, {
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
        report(`${target.name}-os-log-scope`, { pid, last: "2m", predicate });
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
          report(`${target.name}-sandbox-crash-log`, logs);
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
