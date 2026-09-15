import { userInfo } from "node:os";
import { AIError } from "./errors.ts";
import { lstat } from "node:fs/promises";
import type { ProviderId } from "./events.ts";
export function macManagedPaths(
  provider: ProviderId,
  username: string,
): string[] {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(username) ||
    username === "." ||
    username === ".."
  )
    throw new AIError("managed_policy_unsupported");
  const domain =
    provider === "codex" ? "com.openai.codex" : "com.anthropic.claudecode";
  return [
    `/Library/Managed Preferences/${domain}.plist`,
    `/Library/Managed Preferences/${username}/${domain}.plist`,
    ...(provider === "claude"
      ? [
          "/Library/Application Support/ClaudeCode/managed-settings.json",
          "/Library/Application Support/ClaudeCode/managed-settings.d",
          "/Library/Application Support/ClaudeCode/managed-mcp.json",
        ]
      : []),
  ];
}
export const MANAGED_PATHS: Record<ProviderId, string[]> = {
  codex: [
    ...(process.platform === "darwin"
      ? macManagedPaths("codex", userInfo().username)
      : []),
    "/etc/codex/requirements.toml",
    "/etc/codex/managed_config.toml",
    "/etc/codex/config.toml",
  ],
  claude: [
    ...(process.platform === "darwin"
      ? macManagedPaths("claude", userInfo().username)
      : []),
    "/etc/claude-code/managed-settings.json",
    "/etc/claude-code/managed-settings.d",
    "/etc/claude-code/managed-mcp.json",
  ],
};
/** Metadata only: do not load, weaken, or silently omit organization policies.
 * Any present path (including unreadable or symlink) blocks pending a reviewed
 * policy-preserving adapter. No automatic policy execution/copying is supported.
 */
export async function managedPolicyPresent(
  paths: readonly string[],
): Promise<boolean> {
  for (const path of paths) {
    try {
      await lstat(path);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return false;
}
