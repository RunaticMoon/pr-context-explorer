import {
  access,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { isArm64MachO, validateMacNative } from "./macos.ts";
import { probeMacSandbox } from "./macos-runtime.ts";
import { AIError } from "./errors.ts";
import { runBoundedProcess } from "./runner.ts";

export interface SandboxConfig {
  bwrapPath?: string;
  /** Trusted standalone official Node sidecar; never Electron executable. */
  runtimeNodePath?: string;
}
export interface SandboxProbe {
  backend: "linux-bwrap" | "darwin-seatbelt" | "unsupported";
  available: boolean;
  runtimeVerified: boolean;
  blocker: string | null;
  checks?: {
    filesystem: boolean;
    environment: boolean;
    network: boolean;
    cwd: boolean;
    children?: boolean;
  };
}
export interface ReadOnlyMount {
  source: string;
  target: string;
}
export const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const triple =
  process.arch === "arm64"
    ? "aarch64-unknown-linux-musl"
    : "x86_64-unknown-linux-musl";
export const localCodexRoot = `${projectRoot}/.tools/ai-clis/node_modules/@openai/codex-linux-${process.arch === "arm64" ? "arm64" : "x64"}/vendor/${triple}`;
export function cleanEnvironment(): Record<string, string> {
  return {
    HOME: "/home/runner",
    PATH: "/runtime",
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CODEX_HOME: "/home/runner/.codex",
    CLAUDE_CONFIG_DIR: "/home/runner/.claude",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    NODE_EXTRA_CA_CERTS: "/etc/ssl/certs/ca-certificates.crt",
  };
}
/** Only an explicitly configured/trusted native executable, never a shell script. */
export async function nativeExecutable(path: string): Promise<string> {
  try {
    if (!isAbsolute(path)) throw new Error();
    const resolved = await realpath(path);
    if (process.platform === "darwin") {
      if (process.arch !== "arm64") throw new Error();
      await validateMacNative(path);
    }
    await access(resolved, constants.X_OK);
    const file = await open(
      resolved,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat(),
        magic = Buffer.alloc(process.platform === "darwin" ? 4096 : 4);
      await file.read(magic, 0, magic.length, 0);
      if (
        !stat.isFile() ||
        (stat.mode & 0o022) !== 0 ||
        !(process.platform === "darwin"
          ? isArm64MachO(magic)
          : magic.equals(Buffer.from([127, 69, 76, 70])))
      )
        throw new Error();
    } finally {
      await file.close();
    }
    return resolved;
  } catch {
    throw new AIError("cli_missing");
  }
}
export async function resolveBwrap(
  config: SandboxConfig = {},
): Promise<string> {
  if (config.bwrapPath) return nativeExecutable(config.bwrapPath);
  for (const candidate of [
    "/usr/bin/bwrap",
    `${localCodexRoot}/codex-resources/bwrap`,
  ]) {
    try {
      return await nativeExecutable(candidate);
    } catch {
      /* next native installation */
    }
  }
  throw new AIError("sandbox_unavailable");
}
async function librariesFor(
  executable: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const result = await runBoundedProcess({
    executable: "/usr/bin/ldd",
    args: [executable],
    cwd: "/tmp",
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    deadlineMs: 5000,
    signal,
    maxStdoutBytes: 65536,
  });
  const diagnostic = result.stdout + result.stderr;
  if (/not a dynamic executable|statically linked/.test(diagnostic)) return [];
  if (result.exitCode !== 0 || /not found/.test(diagnostic))
    throw new AIError("sandbox_unavailable");
  const paths = [...diagnostic.matchAll(/(?:=>\s+|^\s*)(\/[^\s(]+)/gm)].map(
    (match) => match[1],
  );
  if (paths.some((path) => !/^\/(?:usr\/)?lib(?:32|64)?\//.test(path)))
    throw new AIError("sandbox_unavailable");
  return paths;
}
export async function sandboxRuntime(
  enginePath?: string,
  signal?: AbortSignal,
) {
  const nodePath = await nativeExecutable(process.execPath);
  const libraries = [
    ...new Set(
      (
        await Promise.all(
          [nodePath, ...(enginePath ? [enginePath] : [])].map((p) =>
            librariesFor(p, signal),
          ),
        )
      ).flat(),
    ),
  ];
  return { nodePath, enginePath, libraries };
}
export function buildBwrapArgs(input: {
  nodePath: string;
  enginePath?: string;
  libraries: string[];
  files?: ReadOnlyMount[];
  command: string[];
}): string[] {
  const args = [
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--size",
    "134217728",
    "--tmpfs",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dir",
    "/runtime",
    "--dir",
    "/home",
    "--size",
    "67108864",
    "--tmpfs",
    "/home/runner",
    "--dir",
    "/home/runner/.codex",
    "--dir",
    "/home/runner/.claude",
    "--size",
    "67108864",
    "--tmpfs",
    "/work",
    "--size",
    "67108864",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    input.nodePath,
    "/runtime/node",
  ];
  if (input.enginePath)
    args.push("--ro-bind", input.enginePath, "/runtime/engine");
  for (const lib of input.libraries) args.push("--ro-bind", lib, lib);
  args.push(
    "--ro-bind",
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/certs/ca-certificates.crt",
  );
  for (const file of input.files ?? [])
    args.push("--ro-bind", file.source, file.target);
  args.push("--remount-ro", "/", "--chdir", "/work", "--", ...input.command);
  return args;
}
/** Executes an actual credential-free adversarial probe, never a construction-only success. */
export async function probeSandbox(
  config: SandboxConfig = {},
  enginePath?: string,
  signal?: AbortSignal,
): Promise<SandboxProbe> {
  if (process.platform === "darwin" && process.arch === "arm64")
    return probeMacSandbox(config, enginePath, signal);
  const backend = process.platform === "linux" ? "linux-bwrap" : "unsupported";
  const failed = (blocker: string): SandboxProbe => ({
    backend,
    available: false,
    runtimeVerified: false,
    blocker,
  });
  if (backend === "unsupported")
    return failed("This platform has no runtime-verified isolation adapter.");
  let scratch: string | undefined;
  try {
    if (signal?.aborted) throw new AIError("cancelled");
    const bwrap = await resolveBwrap(config),
      runtime = await sandboxRuntime(enginePath, signal);
    scratch = await mkdtemp("/tmp/ai-isolation-probe-");
    const marker = `${scratch}/host-only-marker`;
    await writeFile(marker, "FAKE HOST SECRET", { mode: 0o600 });
    const script = `const fs=require('fs'),net=require('net');
      const checks={filesystem: !fs.existsSync(${JSON.stringify(marker)}) && !fs.existsSync('/home/ubuntu') && !fs.existsSync('/etc/passwd') && !fs.existsSync('/usr/bin'),
      environment: !process.env.GITHUB_TOKEN && !process.env.GH_TOKEN && !process.env.JIRA_TOKEN && !process.env.NODE_OPTIONS && process.env.HOME==='/home/runner',
      cwd:process.cwd()==='/work',network:false};
      fs.writeFileSync('/work/probe','fake');
      const s=net.connect({host:'1.1.1.1',port:443});let ended=false;
      const finish=(blocked)=>{if(ended)return;ended=true;checks.network=blocked;s.destroy();console.log(JSON.stringify(checks));};
      s.on('connect',()=>finish(false));s.on('error',()=>finish(true));s.setTimeout(1000,()=>finish(true));`;
    const result = await runBoundedProcess({
      executable: bwrap,
      args: buildBwrapArgs({
        ...runtime,
        command: ["/runtime/node", "-e", script],
      }),
      cwd: scratch,
      env: cleanEnvironment(),
      deadlineMs: 5000,
      signal,
      maxStdoutBytes: 65536,
      maxStderrBytes: 65536,
    });
    if (result.exitCode !== 0)
      return failed(
        /Operation not permitted|Permission denied/.test(result.stderr)
          ? "Kernel denied namespace or loopback setup (EPERM); no unsandboxed fallback."
          : "The isolated runtime could not start; no unsandboxed fallback.",
      );
    const checks = JSON.parse(result.stdout) as NonNullable<
      SandboxProbe["checks"]
    >;
    if (
      !["filesystem", "environment", "network", "cwd"].every(
        (key) => checks[key as keyof typeof checks] === true,
      )
    )
      return failed("The runtime isolation probe failed its deny checks.");
    return {
      backend,
      available: true,
      runtimeVerified: true,
      blocker: null,
      checks,
    };
  } catch (e) {
    if (signal?.aborted) throw new AIError("cancelled");
    return failed(
      e instanceof AIError && e.code === "cli_missing"
        ? "A required native sandbox executable is missing or unsupported."
        : "Sandbox prerequisites or runtime verification failed.",
    );
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
