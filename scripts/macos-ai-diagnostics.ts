// Credential-free reproduction only. Never read settings, key files or parent env.
import { spawnSync } from "node:child_process";
import { runBoundedProcess } from "../src/server/ai/runner.ts";
import { lstat, mkdtemp, realpath, readdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { release } from "node:os";
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
      report(`${target.name}-credential-free-startup`, result);
      if (result.exitCode !== 0) process.exitCode = 1;
      // Separate no-auth reproduction, NOT a configurable production profile.
      // Only add denial reporting. In particular keep deny process-fork.
      const reportingProfile = profile.replace(
        "(deny default)",
        "(deny default (with report))",
      );
      report(`${target.name}-reporting-profile`, reportingProfile);
      const observed = spawnSync(
        "/usr/bin/sandbox-exec",
        ["-p", reportingProfile, executable, ...args],
        {
          cwd: dirs.work,
          env: {
            HOME: dirs.home,
            TMPDIR: dirs.tmp,
            CODEX_HOME: dirs.codex,
            CLAUDE_CONFIG_DIR: dirs.claude,
            PATH: "/nonexistent",
            LANG: "en_US.UTF-8",
            LC_ALL: "en_US.UTF-8",
            SSL_CERT_FILE: "/private/etc/ssl/cert.pem",
            NODE_EXTRA_CA_CERTS: "/private/etc/ssl/cert.pem",
          },
          encoding: "utf8",
          timeout: 10000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
        },
      );
      report(`${target.name}-reporting-startup`, {
        pid: observed.pid,
        exitCode: observed.status,
        terminationSignal: observed.signal,
        stdout: observed.stdout,
        stderr: observed.stderr,
        ...(observed.error ? { error: errorCode(observed.error) } : {}),
      });
      // Read only sandbox/crash/signature service events attributed to this
      // exact fake launch PID. No broad node/Claude-name or user-account query.
      if (Number.isSafeInteger(observed.pid) && observed.pid > 0) {
        const pid = observed.pid;
        const predicate = `(process == "kernel" OR process == "sandboxd" OR process == "ReportCrash" OR process == "amfid" OR process == "syspolicyd") AND (eventMessage CONTAINS "(${pid})" OR eventMessage CONTAINS "[${pid}]" OR eventMessage CONTAINS "pid ${pid} " OR eventMessage CONTAINS "pid: ${pid},")`;
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
await main().catch((e) => {
  report("fatal", errorCode(e));
  process.exitCode = 1;
});
