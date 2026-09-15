import { open, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute } from "node:path";
import { AIError } from "./errors.ts";
import { record, type ProviderId } from "./events.ts";
import type { ReadOnlyMount } from "./sandbox.ts";
export type EngineAuth = {
  kind: "api-key-file" | "codex-auth-file" | "claude-oauth-token-file";
  path: string;
};
export interface PreparedAuth {
  env: Record<string, string>;
  files: ReadOnlyMount[];
  mode: "api-key" | "oauth-file" | "oauth-token";
}
async function readPrivate(path: string): Promise<string> {
  if (!isAbsolute(path) || (await realpath(path)) !== path)
    throw new AIError("auth_invalid");
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      stat.size < 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new AIError("auth_invalid");
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) throw new AIError("auth_invalid");
    return bytes.subarray(0, bytesRead).toString("utf8");
  } finally {
    await file.close();
  }
}
function token(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 32768 ||
    /[\s\x00-\x1f\x7f]/.test(value)
  )
    throw new AIError("auth_invalid");
  return value;
}
/** Only called after OS isolation passes; source files are never mounted directly.
 * Canonical credentials are read-only to this adapter; refresh is not persisted.
 */
export async function prepareAuth(
  provider: ProviderId,
  auth: EngineAuth | undefined,
  scratch: string,
): Promise<PreparedAuth> {
  if (!auth) throw new AIError("auth_required");
  if (
    (auth.kind === "codex-auth-file" && provider !== "codex") ||
    (auth.kind === "claude-oauth-token-file" && provider !== "claude")
  )
    throw new AIError("auth_invalid");
  try {
    const text = await readPrivate(auth.path);
    if (auth.kind === "api-key-file")
      return {
        env: {
          [provider === "codex" ? "CODEX_API_KEY" : "ANTHROPIC_API_KEY"]: token(
            text.trim(),
          ),
        },
        files: [],
        mode: "api-key",
      };
    if (auth.kind === "claude-oauth-token-file")
      return {
        env: { CLAUDE_CODE_OAUTH_TOKEN: token(text.trim()) },
        files: [],
        mode: "oauth-token",
      };
    if (auth.kind !== "codex-auth-file") throw new AIError("auth_invalid");
    const source = record(JSON.parse(text)),
      tokens = record(source.tokens),
      minimal: Record<string, unknown> = {};
    if (source.auth_mode === "apikey") {
      minimal.auth_mode = "apikey";
      minimal.OPENAI_API_KEY = token(source.OPENAI_API_KEY);
    } else if (source.auth_mode === "chatgpt") {
      minimal.auth_mode = "chatgpt";
      minimal.tokens = {
        access_token: token(tokens.access_token),
        refresh_token: token(tokens.refresh_token),
        id_token: token(tokens.id_token),
        account_id: token(tokens.account_id),
      };
      if (
        typeof source.last_refresh === "string" &&
        !Number.isNaN(Date.parse(source.last_refresh))
      )
        minimal.last_refresh = source.last_refresh;
    } else {
      // No implicit legacy mode: token-shaped fields cannot repair a missing or
      // unrecognized credential discriminator into a different identity.
      throw new AIError("auth_invalid");
    }
    const copy = `${scratch}/engine-auth.json`;
    await writeFile(copy, JSON.stringify(minimal), { mode: 0o600, flag: "wx" });
    return {
      env: {},
      files: [{ source: copy, target: "/home/runner/.codex/auth.json" }],
      mode: "oauth-file",
    };
  } catch {
    throw new AIError("auth_invalid");
  }
}
