import { trustedMacPath } from "./macos.ts";
import { userInfo } from "node:os";
import { nativeExecutable, projectRoot } from "./sandbox.ts";
import { AIError } from "./errors.ts";
import type { ProviderId } from "./events.ts";

/** Fixed installation locations only. Merely naming a home CLI does not grant
 * the engine access to that home. Never enumerate a home, keychain, or PATH. */
export function macEngineCandidates(
  provider: ProviderId,
  appRoot: string,
  home: string,
): string[] {
  const modules = [
    `${appRoot.replace(/\/$/, "")}/.tools/ai-clis/node_modules`,
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  ];
  const packageName =
    provider === "codex" ? "@openai/codex" : "@anthropic-ai/claude-code";
  const payload =
    provider === "codex" ? "vendor/aarch64-apple-darwin/bin/codex" : "claude";
  return [
    ...modules.flatMap((m) => [
      `${m}/${packageName}-darwin-arm64/${payload}`,
      `${m}/${packageName}/node_modules/${packageName}-darwin-arm64/${payload}`,
    ]),
    `${home}/.local/bin/${provider}`,
    `/opt/homebrew/bin/${provider}`,
    `/usr/local/bin/${provider}`,
  ];
}
async function resolveCandidate(
  provider: ProviderId,
  candidate: string,
): Promise<string> {
  try {
    return await nativeExecutable(candidate);
  } catch {
    // npm's Codex entry is JS; resolve a recognized installed layout without
    // evaluating its wrapper, package.json, postinstall, shell, or module code.
    if (provider !== "codex" || !candidate.startsWith("/"))
      throw new AIError("cli_missing");
    const resolved = await trustedMacPath(candidate);
    const suffix = "/@openai/codex/bin/codex.js";
    if (!resolved.endsWith(suffix)) throw new AIError("cli_missing");
    const modules = resolved.slice(0, -suffix.length);
    for (const path of [
      `${modules}/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
      `${modules}/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`,
    ]) {
      try {
        return await nativeExecutable(path);
      } catch {
        /* only reviewed native layouts */
      }
    }
    throw new AIError("cli_missing");
  }
}
export async function resolveMacEngine(
  provider: ProviderId,
  configured?: string,
): Promise<string> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new AIError("cli_missing");
  if (configured) return resolveCandidate(provider, configured);
  for (const candidate of macEngineCandidates(
    provider,
    projectRoot,
    userInfo().homedir,
  )) {
    try {
      return await resolveCandidate(provider, candidate);
    } catch {
      /* next exact installation */
    }
  }
  throw new AIError("cli_missing");
}
