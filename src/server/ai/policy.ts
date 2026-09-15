import { lstat } from "node:fs/promises";
import type { ProviderId } from "./events.ts";
export const MANAGED_PATHS: Record<ProviderId, string[]> = {
  codex: [
    "/etc/codex/requirements.toml",
    "/etc/codex/managed_config.toml",
    "/etc/codex/config.toml",
  ],
  claude: [
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
