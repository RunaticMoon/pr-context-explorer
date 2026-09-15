import { resolveMacEngine } from "./macos-discovery.ts";
import { runSeatbeltCommand } from "./macos-runtime.ts";
import { MANAGED_PATHS, managedPolicyPresent } from "./policy.ts";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import {
  buildInvocation,
  inspectCapabilities,
  parseAuthStatus,
  type Capabilities,
} from "./cli.ts";
import {
  cleanEnvironment,
  localCodexRoot,
  nativeExecutable,
  projectRoot,
} from "./sandbox.ts";
import { runBoundedProcess, type ProcessResult } from "./runner.ts";
import type { ProviderId } from "./events.ts";
import type { ProviderConfig } from "./types.ts";
import { AIError } from "./errors.ts";
export interface CliProbe {
  executablePath: string | null;
  capabilities: Capabilities;
  emptyAuthStatus: ReturnType<typeof parseAuthStatus>;
}
async function resolveEngine(
  provider: ProviderId,
  configured?: string,
): Promise<string> {
  if (process.platform === "darwin")
    return resolveMacEngine(provider, configured);
  if (configured) return nativeExecutable(configured);
  const local =
    provider === "codex"
      ? `${localCodexRoot}/bin/codex`
      : `${projectRoot}/.tools/ai-clis/node_modules/@anthropic-ai/claude-code-linux-${process.arch === "arm64" ? "arm64" : "x64"}/claude`;
  for (const path of [
    local,
    `/usr/local/bin/${provider}`,
    `/usr/bin/${provider}`,
  ]) {
    try {
      return await nativeExecutable(path);
    } catch {
      /* next approved installation location */
    }
  }
  throw new AIError("cli_missing");
}
/** Credential-free --help/--version/feature-list/status use private HOME/cwd.
 * Darwin also runs these through Seatbelt with all networking denied; Linux
 * retains its existing credential-free preflight outside bwrap.
 */
export async function probeCli(
  provider: ProviderId,
  config: ProviderConfig = {},
  signal?: AbortSignal,
  // Opt-in local diagnostics ONLY for this credential-free preflight. Never
  // attach this hook to authenticated analysis or print the parent's env.
  onDiagnostic?: (args: string[], result: ProcessResult) => void,
): Promise<CliProbe> {
  let scratch: string | undefined;
  try {
    if (
      process.platform === "darwin" &&
      (await managedPolicyPresent(MANAGED_PATHS[provider]))
    )
      throw new AIError("managed_policy_unsupported");
    const executablePath = await resolveEngine(provider, config.executablePath);
    scratch = await realpath(await mkdtemp("/tmp/ai-cli-probe-"));
    const env = {
      ...cleanEnvironment(),
      HOME: scratch,
      CODEX_HOME: `${scratch}/.codex`,
      CLAUDE_CONFIG_DIR: `${scratch}/.claude`,
      TMPDIR: scratch,
    };
    await Promise.all([mkdir(env.CODEX_HOME), mkdir(env.CLAUDE_CONFIG_DIR)]);
    const run = async (args: string[]) => {
      const result = await (process.platform === "darwin"
        ? runSeatbeltCommand({
            executablePath,
            args,
            scratch: scratch!,
            process: {
              signal,
              deadlineMs: 10000,
              maxStdoutBytes: 256 * 1024,
              maxStderrBytes: 65536,
            },
          })
        : runBoundedProcess({
            executable: executablePath,
            args,
            cwd: scratch!,
            env,
            signal,
            deadlineMs: 10000,
            maxStdoutBytes: 256 * 1024,
            maxStderrBytes: 65536,
          }));
      onDiagnostic?.(args, result);
      return result;
    };
    const [version, help, execHelp, features] = await Promise.all([
      run(["--version"]),
      run(["--help"]),
      provider === "codex" ? run(["exec", "--help"]) : Promise.resolve(null),
      provider === "codex" ? run(["features", "list"]) : Promise.resolve(null),
    ]);
    const capabilities = inspectCapabilities(
      provider,
      version.stdout,
      help.stdout + (execHelp?.stdout ?? ""),
      features?.stdout,
    );
    if (
      version.exitCode !== 0 ||
      help.exitCode !== 0 ||
      (execHelp && execHelp.exitCode !== 0) ||
      (features && features.exitCode !== 0)
    ) {
      capabilities.supported = false;
      capabilities.missing.push("probe-command-failed");
    }
    if (capabilities.supported) {
      // Check parsing of the exact production flag set without sending inference.
      const invocation = buildInvocation(provider, {
        model: "capability-probe-only",
        schema: { type: "object" },
        context: {},
        trustedPrompt: "Capability probe only.",
        authMode: "api-key",
      });
      const check = await run([...invocation.args, "--help"]);
      if (check.exitCode !== 0) {
        capabilities.supported = false;
        capabilities.missing.push("argument-parse-check");
      }
    }
    let emptyAuthStatus: CliProbe["emptyAuthStatus"] = "unknown";
    if (capabilities.supported) {
      const status = await run(
        provider === "codex"
          ? ["login", "status"]
          : [
              "--safe-mode",
              "--restricted",
              "--strict-mcp-config",
              "--setting-sources",
              "",
              "auth",
              "status",
            ],
      );
      emptyAuthStatus = parseAuthStatus(
        provider,
        status.exitCode,
        status.stdout,
        status.stderr,
      );
    }
    return { executablePath, capabilities, emptyAuthStatus };
  } catch (e) {
    if (signal?.aborted) throw new AIError("cancelled");
    return {
      executablePath: null,
      capabilities: {
        supported: false,
        version: null,
        missing: [e instanceof AIError ? e.code : "cli_missing"],
      },
      emptyAuthStatus: "unknown",
    };
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}
