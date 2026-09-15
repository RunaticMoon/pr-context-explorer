import { AIError } from "./errors.ts";
import { record, type ProviderId } from "./events.ts";
import type { PreparedAuth } from "./auth.ts";
export const REVIEWED_VERSIONS = {
  codex: "0.154.0",
  claude: "2.1.270",
} as const;
export const CODEX_DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "shell_snapshot",
  "code_mode",
  "code_mode_host",
  "apps",
  "hooks",
  "plugins",
  "remote_plugin",
  "multi_agent",
  "multi_agent_v2",
  "browser_use",
  "browser_use_external",
  "computer_use",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "goals",
  "memories",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "request_permissions_tool",
  "workspace_dependencies",
  "view_image",
  "unbounded_connection_retries",
] as const;
const REQUIRED_FLAGS = {
  codex: [
    "--json",
    "--output-schema",
    "--sandbox",
    "--model",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--disable",
    "--ask-for-approval",
  ],
  claude: [
    "--print",
    "--output-format",
    "--json-schema",
    "--model",
    "--safe-mode",
    "--restricted",
    "--tools",
    "--strict-mcp-config",
    "--setting-sources",
    "--disable-slash-commands",
    "--permission-mode",
    "--permission-prompts",
    "--no-session-persistence",
    "--include-partial-messages",
    "--system-prompt",
    "--verbose",
    "--no-chrome",
  ],
};
export interface Capabilities {
  supported: boolean;
  version: string | null;
  missing: string[];
}
export function inspectCapabilities(
  provider: ProviderId,
  versionOutput: string,
  help: string,
  features = "",
): Capabilities {
  const version = versionOutput.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null;
  const missing = REQUIRED_FLAGS[provider].filter(
    (flag) => !help.includes(flag),
  );
  if (version !== REVIEWED_VERSIONS[provider]) missing.push("reviewed-version");
  if (provider === "codex")
    for (const feature of [
      ...CODEX_DISABLED_FEATURES,
      "skip_host_skill_discovery",
    ]) {
      if (!features.split("\n").some((line) => line.startsWith(`${feature} `)))
        missing.push(`feature:${feature}`);
    }
  return { supported: missing.length === 0, version, missing };
}
export function parseAuthStatus(
  provider: ProviderId,
  exitCode: number | null,
  stdout: string,
  stderr: string,
): "authenticated" | "not_authenticated" | "unknown" {
  if (provider === "codex") {
    if (
      exitCode === 0 &&
      /Logged in using (?:ChatGPT|an API key|API key)/i.test(stdout + stderr)
    )
      return "authenticated";
    if (exitCode === 1 && /Not logged in/i.test(stdout + stderr))
      return "not_authenticated";
  } else {
    try {
      const value = record(JSON.parse(stdout));
      if (exitCode === 0 && value.loggedIn === true) return "authenticated";
      if (exitCode === 1 && value.loggedIn === false)
        return "not_authenticated";
    } catch {
      /* no fabricated success */
    }
  }
  return "unknown";
}
export interface InvocationInput {
  model: string;
  schema: object;
  context: unknown;
  trustedPrompt: string;
  authMode: PreparedAuth["mode"];
}
export function buildInvocation(
  provider: ProviderId,
  input: InvocationInput,
): { args: string[]; stdin: string } {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(input.model) ||
    input.model.includes("..")
  )
    throw new AIError("invalid_request");
  const stdin = JSON.stringify({ SOURCE_BUNDLE_JSON: input.context });
  if (provider === "codex") {
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "--model",
      input.model,
      "--output-schema",
      "/runtime/schema.json",
    ];
    const overrides = [
      'model_provider="openai"',
      'web_search="disabled"',
      "project_doc_max_bytes=0",
      "project_doc_fallback_filenames=[]",
      "mcp_servers={}",
      "allow_login_shell=false",
      'cli_auth_credentials_store="file"',
      "check_for_update_on_startup=false",
      "analytics.enabled=false",
      "feedback.enabled=false",
      'shell_environment_policy.inherit="none"',
      'shell_environment_policy.include_only=["PATH","HOME"]',
      "tools.update_plan.enabled=false",
      `developer_instructions=${JSON.stringify(input.trustedPrompt)}`,
    ];
    for (const value of overrides) args.push("-c", value);
    for (const feature of CODEX_DISABLED_FEATURES)
      args.push("--disable", feature);
    args.push("--enable", "skip_host_skill_discovery", "-");
    return { args, stdin };
  }
  // --safe-mode preserves official OAuth; --bare does not. Empty tools plus no
  // MCP is stronger than --allowedTools, which merely suppresses approvals.
  return {
    args: [
      "--print",
      "--safe-mode",
      "--restricted",
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--no-session-persistence",
      "--no-chrome",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--max-turns",
      "3",
      "--model",
      input.model,
      "--json-schema",
      JSON.stringify(input.schema),
      "--system-prompt",
      input.trustedPrompt,
    ],
    stdin,
  };
}
