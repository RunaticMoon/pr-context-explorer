# AI CLI adapters: integration contract and verification

## Current result

Standalone server-only module at `src/server/ai/index.ts`; it does not import the application's Snapshot, Analysis, provider, or contract modules. No existing provider/UI/package files were changed by this work.

**Actual host verification:** native Codex **0.154.0** and Claude Code **2.1.270** were installed in the project-owned `.tools/ai-clis` prefix. `--version`, official help, Codex feature listing, exact production-argument parsing with `--help`, and credential-free official authentication-status commands were executed. Both installations pass the adapter's capability checks. Neither engine was authenticated. **No real inference or model entitlement was tested.**

**Isolation blocker:** Linux bubblewrap bundled with Codex is present, but an actual invocation fails with namespace/loopback **EPERM**. `unshare --user --map-root-user /usr/bin/true` also failed when writing `uid_map`. The runtime probe therefore returns `available:false, runtimeVerified:false`; analysis fails with `sandbox_unavailable` before reading credentials or sending the source bundle. Installing another CLI, using a different prompt, or constructing a plausible sandbox command cannot turn that into a passing isolation test. No privilege escalation, service changes, kernel-policy changes, or unsafe bypass flags were used.

## Public API

```ts
import {
  probeProviders, runAnalysis, AIError,
  type AIConfig, type AnalysisRequest, type AnalysisResult,
  type ProviderProbe, type ProviderId, type EngineAuth, type AIEvent,
} from './ai/index.ts';

probeProviders(config?: AIConfig): Promise<ProviderProbe[]>
runAnalysis(request: AnalysisRequest): Promise<AnalysisResult>
```

```ts
interface AnalysisRequest {
  providerId: "codex" | "claude";
  model: string; // required, never guessed or silently changed
  schema: object; // caller's JSON Schema; supported draft: draft-07
  context: unknown; // JSON-serializable source bundle, never a path to read
  trustedPrompt: string; // server-constructed instructions, not source material
  signal?: AbortSignal;
  onEvent?: (event: AIEvent) => void; // synchronous, cheap progress consumer
  config?: AIConfig;
}

interface AIConfig {
  providers?: {
    codex?: { executablePath?: string; auth?: EngineAuth };
    claude?: { executablePath?: string; auth?: EngineAuth };
  };
  sandbox?: { bwrapPath?: string };
  deadlineMs?: number;
  inactivityMs?: number;
  maxInputBytes?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

type EngineAuth = {
  kind: "api-key-file" | "codex-auth-file" | "claude-oauth-token-file";
  path: string;
};
```

**Configuration is server-owned.** Do not accept executable paths, auth paths, sandbox configuration, schema, or trusted instructions from a browser request. There is no arbitrary shell command, extra-args, environment passthrough, custom model base URL, custom mounts, fake provider, or injectable runner in the public API.

`runAnalysis` returns `{ output: unknown, metadata: {...} }`. Metadata includes `providerId`, requested `model`, `observedModel` (nullable; never fabricated), checked `cliVersion`, wall timestamps and duration, whitelisted numeric usage, bounded stream byte counts, `schemaValidated:true`, `referenceValidation:'caller-required'`, `isolation:'linux-bwrap'`, `fallbackUsed:false`, and `parserVersion:'1'`. **`metadata.model` is the requested identifier**, not a claim that an alias was resolved to that exact underlying model. The final output is separate from the CLI event/result envelope.

The caller must still validate snapshot/SHA/file/evidence references, graph consistency, coverage, and semantic grounding before caching or displaying output. Context chunking and synthesis belong to the caller; the adapter rejects oversized input instead of truncating or summarizing it secretly.

`probeProviders()` always returns both providers. Each result includes installation/version/capabilities, authentication status, isolation result, blocker codes, `ready`, and `inferenceVerified:false`. `ready` requires an explicit positive CLI auth-status result as well as capability and isolation checks. An auth file's existence, missing error text, or exit status without the expected envelope never means authenticated. CLI status is **not** a remote entitlement or billing validation: `networkValidated:false` is explicit. `CODEX_API_KEY` is an exec credential, so `login status` cannot certify that mode and the probe leaves it `unknown`; an explicitly authorized analysis may still attempt that mode after isolation passes.[12]

### Example (server-side only)

```ts
const config: AIConfig = {
  providers: {
    codex: {
      // Optional when the project-owned native installation is present.
      executablePath: "/operator-managed/native/codex",
      auth: {
        kind: "codex-auth-file",
        path: "/private/approved/codex-auth.json",
      },
    },
  },
  deadlineMs: 120_000,
  inactivityMs: 45_000,
};

const result = await runAnalysis({
  providerId: "codex",
  model: selectedModel,
  schema: applicationOutputSchema,
  context: boundedContextBundle,
  trustedPrompt: applicationRuntimePrompt,
  config,
  signal: requestAbortSignal,
  onEvent: (event) => sendProgress(event),
});
// deterministicReferenceValidator(result.output, originalSnapshot) belongs here.
```

Paths above are examples, not installed credentials. Obtain organizational approval for transmitting the selected code/context to the selected model service.

## Engine invocations and official evidence

### Codex

Uses official noninteractive `codex exec`, JSONL `--json`, and `--output-schema` with a caller-owned schema staged read-only. Source is serialized as `{"SOURCE_BUNDLE_JSON": context}` and sent only on stdin, with `-` as the prompt argument. No source tree or source text is staged on host disk.[1][9]

The exact reviewed invocation explicitly uses `--ask-for-approval never`, `--sandbox read-only`, `--ignore-user-config`, `--ignore-rules`, `--strict-config`, `--skip-git-repo-check`, `--ephemeral`, `--color never`, and the requested `--model`. It fixes the built-in OpenAI provider, disables web search, sets project instruction bytes to zero, clears MCP configuration, disables update/analytics/feedback, disallows login shells, and constrains shell environment inheritance. The trusted prompt is a developer-instruction config value, never source-derived.[1][2][6]

The pinned feature list disables shell/unified execution, code-mode hosts, apps, hooks, plugins, remote plugins, multi-agent, browser/computer/image tools, memories/goals, skill auto-install/search, and other discovered expansion features. `skip_host_skill_discovery` is explicitly enabled. These names were checked against **the installed feature listing** and the official config schema for the exact release.[6]

**Do not call this an all-tools-disabled Codex API.** Codex does not expose Claude's `--tools ""` interface, and its reviewed source still registers some model-dependent utility/edit tools. The filesystem sandbox is the decisive boundary: all target/home/source trees are absent, auth/schema/runtime files are read-only, and only disposable scratch is writable. Any non-message/reasoning/todo item in the JSONL stream is rejected as `tool_use_forbidden`; event rejection is a secondary audit, not permission enforcement. The pinned upstream tool-plan source is retained in `artifacts/ai-codex-codex-rs-core-src-tools-spec_plan.rs` for review.

### Claude Code

Uses `--print`, `--output-format stream-json`, `--verbose`, `--include-partial-messages`, `--json-schema`, and the caller's model. It applies `--safe-mode --restricted`, `--tools ""`, `--strict-mcp-config`, empty setting sources, disabled slash commands, `dontAsk` permissions, no permission prompts, no browser integration/session persistence, and `--max-turns 3`. `--allowedTools` alone would only affect approvals; it is not a complete tool availability restriction.[4][5]

**No `--bare`:** the installed help and official headless guide say bare mode never reads OAuth/keychain credentials. Safe mode preserves authentication while removing customization discovery. This avoids silently rejecting approved subscription authentication.[4][5]

`--max-turns` is hidden from the installed top-level help, but documented officially and accepted by the exact-argument help probe. `--safe-mode`, `--restricted`, and permission-prompt behavior are described in the installed official binary's help. Parsing help is evidence of option support, **not** evidence that an authenticated structured-output run succeeded.

The parser extracts only the final success result's `structured_output`, never `result` prose. The pure formatting `StructuredOutput` event is permitted; executable tool events, server tools, and MCP lookalikes are rejected. Model reasoning, raw assistant events, error diagnostics, session data, and tool arguments are not streamed to the caller.

Both adapters are **exact-version pinned** to reviewed safety behavior; newer versions fail `unsupported_cli` until reviewed. No model availability list, subscription fact, price, or context-window size is invented.

## Authentication and secret boundary

- There is **no automatic access** to `~/.codex`, `~/.claude`, system keychains, Hermes credentials, GitHub/Jira tokens, or other services' authentication.
- A credential is read only after OS isolation passes, from an explicitly supplied canonical absolute path. It must be a regular file owned by the application UID, with no group/other permissions, no symlink path, and a size of at most 64 KiB. Named pipes, oversized files, and cross-provider auth kinds fail closed.
- `api-key-file`: a private single-token file becomes only `CODEX_API_KEY` for Codex or `ANTHROPIC_API_KEY` for Claude. Tokens are never command arguments, prompt/stdin, or diagnostics.[7][12]
- `codex-auth-file`: only known credential fields from the official Codex `auth.json` shape are copied to a private per-run file; arbitrary config, MCP, instructions, and unknown fields are discarded. That copy is mounted read-only as the isolated `CODEX_HOME/auth.json`. Official file storage and portable `auth.json` are documented by OpenAI.[3]
- Codex canonical files are **never modified**. Read-only copies may prevent OAuth refresh; expired/refresh-required credentials must be renewed using the official CLI outside this adapter. Refresh persistence and keyring access are not implemented.
- `claude-oauth-token-file`: the contents of a user-authorized token file become only `CLAUDE_CODE_OAUTH_TOKEN`. Anthropic documents tokens generated by the official `claude setup-token` flow for scripts/CI. The adapter never runs that login flow or mints credentials itself.[7]
- Claude's canonical keychain/credential-store refresh flow, third-party Bedrock/Vertex/Foundry credentials, custom endpoints, corporate proxies, and custom mTLS identities are not supported. Do not copy unrelated account/config files to make them appear supported.
- No real credentials were copied for this implementation. Tests use conspicuously fake, temporary secrets.
- Credentials remain in process memory/environment for the selected CLI, and Linux root/kernel or a sufficiently privileged same-host observer remains outside this boundary. Temporary cleanup is not a secure-erasure guarantee. Core dumps/service identity hardening, concurrency admission, CPU/memory/cgroup budgets, and deployment policy belong to deployment integration.

Known local managed-policy paths are checked by metadata only. If present, the adapter refuses analysis with `managed_policy_unsupported` rather than silently hiding organization constraints. Policy-preserving managed configuration has not been implemented. Server-managed policy/organization compatibility still requires an authorized account smoke test.[10][11]

## Concrete isolation and egress

`buildBwrapArgs` creates a disposable root with separate user/PID/network/IPC/UTS namespaces, drops capabilities, disables nested user namespaces, and enables die-with-parent behavior. It mounts **individual native executables and their `ldd`-identified system library files**, the system PEM CA bundle, the adapter launcher, schema, one Unix proxy socket, and the minimized auth copy. It never mounts `/`, `/home`, `/tmp`, `/usr`, `/usr/bin`, `/etc`, a target checkout, the entire CLI package, or a user's home tree from the host. Empty `/work`, `/tmp`, and `/home/runner` are size-limited tmpfs mounts. The root and input/runtime files are read-only.

Only trusted native ELF installations with non-group/world-writable executable files are accepted. JS/shell CLI wrappers are not accepted as executable paths; point at their installed native payload. Discovery checks the project-owned native packages, then `/usr/local/bin` and `/usr/bin`; it does not search an inherited arbitrary PATH. Required libraries outside standard system library paths fail closed.

The network namespace has no external interface. A small executable Node launcher runs a loopback relay to a single host Unix CONNECT proxy. The proxy permits only exact provider TLS authorities:

- Codex: `api.openai.com:443`, `chatgpt.com:443`, `auth.openai.com:443`.
- Claude: `api.anthropic.com:443`, `platform.claude.com:443`, `console.anthropic.com:443`.

This is the adapter's deliberately narrow egress policy, **not** a claim to cover every organization/login/telemetry workflow. Normal HTTP, arbitrary hosts/ports, suffix tricks, IP authorities, inherited proxy settings, DNS results in private/reserved IPv4 ranges, and redirect destinations outside the allowlist are rejected. DNS resolution is host-side, the approved numeric address is pinned, TLS remains end-to-end, and no TLS verification is disabled. IPv6-only provider destinations are currently unsupported. CONNECT restricts hosts, not encrypted URL paths. The relay does not supply credentials to the proxy. Claude documents the standard HTTPS proxy variables used here.[8]

Proxy sockets, transfer bytes, request headers, connections, and idle time are bounded; sockets close when the analysis ends. A provider requiring another host fails rather than automatically expanding the allowlist. The positive authenticated CLI-through-proxy path remains unverified on this kernel; tested local Unix-proxy denial is not equivalent to a successful OS-isolated provider connection.

`probeSandbox` actually runs a credential-free fake process that checks filesystem invisibility, scrubbed environment, clean cwd, scratch write access, and denied direct networking. A constructor test is separate from runtime verification. This host fails before that process can start. macOS/Windows report unsupported; no untested `sandbox-exec` profile is advertised as working.

## Bounds, events, and failure semantics

| Limit                                                   | Default                            | Server-configurable upper bound |
| ------------------------------------------------------- | ---------------------------------- | ------------------------------- |
| Full admitted-request deadline, including CLI preflight | 120 seconds                        | 600 seconds                     |
| Output inactivity                                       | Off; independent optional deadline | 600 seconds                     |
| Serialized source input                                 | 1 MiB                              | 8 MiB                           |
| stdout                                                  | 4 MiB                              | 16 MiB                          |
| stderr                                                  | 256 KiB                            | 1 MiB                           |
| Trusted prompt / schema                                 | 64 KiB each                        | Fixed                           |
| NDJSON line                                             | 2 MiB                              | Fixed                           |
| NDJSON event count                                      | 10,000                             | Fixed                           |

The process primitive uses `spawn(executable, args, {shell:false, detached:true})`, private cwd, and an explicit environment. It checks pre-abort before spawn, tracks a full deadline independent of output activity, optionally tracks inactivity, counts byte caps separately and jointly, and kills the POSIX process group on cancellation, timeout, cap violation, callback failure, and parent exit. The bwrap PID namespace adds containment for descendants that change session/group. Internal `runBoundedProcess` is deliberately **not exported from the public index** and is not itself an OS sandbox.

The streaming parser handles split UTF-8 and split lines, rejects invalid UTF-8/JSON, missing/duplicate/out-of-order terminal envelopes, disallowed tools, and schema mismatches. Codex commentary is not treated as final JSON until the turn completes. Ajv validates caller schemas and final output without coercion or automatic removal of fields; unsupported schemas/formats fail rather than being weakened. App-level references remain caller work.

Progress is a small fixed vocabulary: status `preparing/running/validating/completed`, progress `started/generating/retrying`. Consumers must be synchronous and non-blocking; Promise-returning progress callbacks are rejected safely rather than creating unhandled rejections. No internal reasoning or unvalidated final prose is sent as UI content. CLI errors are normalized into safe `AIError.code` values such as `cancelled`, `timeout`, `inactivity_timeout`, `output_limit`, `input_limit`, `auth_invalid`, `quota_exceeded`, `rate_limited`, `model_unavailable`, `invalid_json`, `invalid_envelope`, and `schema_mismatch`. Raw stdout/stderr, argv, credentials, and source fragments are never attached to thrown public errors.

The adapter makes no repair retries or model/provider fallbacks. CLI-internal retries may occur within the hard deadline; retry events become generic progress. No live account call or authenticated retry was exercised here.

## Verification and reproduction

Final execution: **52 AI tests passed, 0 failed, 0 skipped**; the complete project TypeScript check exited **0** with no diagnostics. These results do not certify a working kernel sandbox or real model inference.

```sh
# Project-local installation; no root/global package or app lock changes.
npm install --prefix .tools/ai-clis --no-audit --no-fund --package-lock=false \
  @openai/codex@0.154.0 @anthropic-ai/claude-code@2.1.270

# Explicit test file list avoids a runtime command-guard false positive seen here.
node --import tsx --test tests/ai-auth.test.ts tests/ai-cli.test.ts \
  tests/ai-egress.test.ts tests/ai-events.test.ts tests/ai-index.test.ts \
  tests/ai-launcher.test.ts tests/ai-pipeline.test.ts \
  tests/ai-runner.test.ts tests/ai-sandbox.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

The npm-native payloads shipped with group-write mode on this host. Their exact project-local native executable files were changed to `0755`; no host service or global binary was modified. Preserve trusted installation ownership/ancestors when deploying. Native binaries under `.tools/ai-clis` are development tools, not application dependencies or credential files.

Tests include executable fake processes for actual env/cwd/stdin observations, split JSON streaming/Ajv integration, cancellation and descendant termination, continuous-output timeout, inactivity, separate byte caps, pre-abort/no-spawn, safe auth/quota errors, private credential-file handling, Unix-proxy denials and launcher relay, schema mismatch, malformed/out-of-order output, version/flag drift, and kernel fail-closed behavior. Fake processes are explicitly labeled; no fabricated model answer is exposed by `runAnalysis`.

Evidence is retained in:

- `artifacts/ai-cli-verification.json`: executed help/version/feature-list/empty-home auth-status and initial bubblewrap failure.
- `artifacts/ai-option-check.json`: argument parsing with no inference.
- `artifacts/ai-provider-probe.json`: actual public capability results, including both blockers.
- `artifacts/ai-test-results.txt`, `artifacts/ai-typecheck.txt`: final test/compiler output.
- `artifacts/ai-source-*.md`, `artifacts/ai-codex-config-schema.json`, and pinned upstream tool source: retrieved references. Some web-extractor captures are partial; official URLs and installed help remain the primary evidence.

### Remaining release gates

1. A permitted Linux namespace runtime must pass the actual fake isolation probe under the eventual service identity. This cannot be verified on the current host without an independently authorized environment change.
2. An operator must authorize a supported credential path and selected model, data transmission, and any account/organization policy. No credentials were guessed, borrowed, or retrieved from another service.
3. Run an opt-in authenticated tiny-schema smoke for **each selected auth mode/provider** through the actual bwrap/egress path. Verify no configuration auto-load, resolved model metadata when supplied, schema output, token expiry, and expected networking. Help/argument checks do not replace this.
4. Parent integration must enforce service-side configuration, reference validation, bounded context chunking, cache privacy, concurrency/billing admission, and HTTP cancellation propagation. An independent integration/security review is still required before production use.

## Sources

[1] https://developers.openai.com/codex/cli/reference
[2] https://developers.openai.com/codex/config-reference
[3] https://developers.openai.com/codex/auth
[4] https://code.claude.com/docs/en/cli-reference
[5] https://code.claude.com/docs/en/headless
[6] https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/core/config.schema.json
[7] https://code.claude.com/docs/en/authentication.md
[8] https://code.claude.com/docs/en/network-config.md
[9] https://developers.openai.com/codex/noninteractive
[10] https://developers.openai.com/codex/enterprise/managed-configuration
[11] https://code.claude.com/docs/en/settings.md
[12] https://learn.chatgpt.com/docs/config-file/environment-variables
