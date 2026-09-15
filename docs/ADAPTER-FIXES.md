# Adapter validation fixes

Verified on 2026-09-14 (UTC) in `/home/ubuntu/development/pr-context-explorer`.
Scope: five independently reproduced AI/Jira adapter defects. No sandbox,
launcher, worker, root configuration, lockfile, UI or core implementation changes.
This directory has no Git repository metadata; verification is against source and
executed tests, not a Git diff or a commit.

## Fixed behaviors and permanent regressions

| Review ID | Change | Permanent regression coverage |
| --- | --- | --- |
| ADAPTER-1 | Jira checks every decoded JSON string value and property name for credential reflection, iteratively after depth/node bounds and before returning any source. Rejects the affected response; does not redact it and claim exact evidence. The same read session covers primary/related issues and comments. | `tests/jira-validation-security.test.ts`: real loopback HTTPS, escaped values, keys and nested arrays/objects in both issue and comment responses; accepted-source byte/hash control. Rejected optional comments retain the safe primary issue but no rejected comment page/body. Existing literal-reflection, deadline, size and TLS tests still pass. |
| ADAPTER-2 | The reviewed IPv4 deny table now includes the whole `192.88.99.0/24` deprecated relay range, including `.2`. | `tests/ai-egress.test.ts`: first/last addresses of every denied prefix, every address in the newly denied /24, adjacent addresses and noncanonical/IPv6 inputs. Exact authority matching, all-answer DNS screening, numeric connect pinning and end-to-end TLS behavior are unchanged. |
| ADAPTER-3 | Provider envelopes use explicit reviewed type/subtype allowlists. Unknown events, blocks and deltas fail; executable tool activity cannot be silently ignored before a valid final answer. | `tests/ai-event-audit.test.ts`: both providers' unknown events and Bash progress, Codex execution/file/MCP/collaboration/search items at all lifecycle stages, Claude tool summaries/results, nested message-start tools, server tools, hooks, subagent/deferred-tool markers and non-string discriminators. Positive reviewed lifecycle, text/thinking and formatting-only streams remain accepted. `tests/ai-events.test.ts` retains all prior behaviors; its event-count fixture now uses valid `system/init` envelopes rather than missing subtypes. |
| ADAPTER-4 | Codex auth files accept only explicit `auth_mode: "apikey"` with its API key, or `auth_mode: "chatgpt"` with all four token/account fields. Unknown, wrong-type and **missing** modes reject with `auth_invalid`, without writing an isolated copy or modifying the source. | `tests/ai-auth.test.ts`: unsupported/missing modes despite complete token-shaped fields, incomplete/cross-mode credential shapes, supported API-key control, existing ChatGPT copy/read-only/control-field stripping tests. Legacy absent-discriminator files are deliberately unsupported; there is no automatic identity repair. |
| ADAPTER-5 | Every recognized ADF container checks child-array shape, required presence/nonempty constraints and supported child placement; leaves check required text and disallowed children. Required heading/panel attributes and malformed attribute/mark containers are checked. Malformed source is `partial` with exact JSON Pointers, never genuine emptiness. | `tests/jira-normalization.test.ts`: all recognized containers, malformed leaves/attributes/marks, invalid child placement, hostile node names, valid empty inline containers and valid nesting. `tests/jira-validation-security.test.ts`: actual HTTPS issue and comment malformed ADF, exact raw bytes/hash and `/fields/description/content/0/content` or `/comments/0/body/content/0/content` pointers. |

The text normalizer identity is now `jira-text-v2`, so aggregate capture hashes
cannot reuse the old coverage semantics. Exact response-byte hashes are unchanged.
This is structural validation of the supported **plain-text normalization subset**,
not a claim to implement all ADF rendering, formatting attributes or extensions.
Unsupported content remains raw evidence and explicitly partial. Optional comment
retrieval coverage and each comment body's normalization coverage are separate.

## Reviewed stream contract

- **Codex 0.154.0:** `thread.started`, `turn.started`, `turn.completed`,
  `item.started`, `item.updated`, `item.completed`; `error` and `turn.failed`
  always reject through safe error classification. Only `agent_message`,
  `reasoning` and `todo_list` item kinds are accepted. All other item kinds reject.
- **Claude CLI 2.1.270 / SDK declarations 0.3.270:** `system` subtypes `init`,
  `api_retry`, `compact_boundary`, `thinking_tokens`, `status` (null, compacting,
  requesting), and `session_state_changed` (idle, running, requires_action).
  Also `rate_limit_event` (allowed, allowed_warning, rejected), `assistant`,
  audited `user`, `stream_event`, and `result`.
- Reviewed nested stream kinds: `message_start`, `content_block_start`,
  `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`,
  `ping`; nested `error` rejects. Reviewed content/delta kinds are text, thinking,
  redacted thinking, text/thinking/signature deltas and formatting-only tool/input
  deltas. Unknown kinds reject rather than being silently interpreted as metadata.
- The exact `StructuredOutput` tool name is the only formatting exception; it is
  not an exception for MCP lookalikes, shell tools or server tools. Progress,
  summaries and user tool results must reference previously audited formatting
  call IDs; mixed/unseen IDs reject. JSON-input deltas must refer to an active
  formatting block. Tool-result blocks cannot hide nested tool envelopes.
- Claude success requires `structured_output`; known error result subtypes
  reject. The existing legacy `result/error` diagnostic is retained only as a
  rejection path. Subagents, deferred tools and nonempty permission denials reject.
- Other SDK features/envelopes (including hook/task/plugin/control workflows and
  new API block variants) are not enabled by this allowlist. Version upgrades
  require explicit review and positive/negative fixtures, not a default ignore.
  The event audit is defense in depth, **not** proof of OS isolation.

References reviewed (no provider account or model call):

- [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry.xhtml).
- [RFC 7526, sections 4 and 7](https://www.rfc-editor.org/rfc/rfc7526.txt).
  Denial here is the application's conservative provider-egress policy; the RFC
  does not itself recommend generalized filtering of all 6to4 traffic.
- [Codex pinned `exec_events.rs`](https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/exec/src/exec_events.rs).
- [Claude pinned SDK declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.270/sdk.d.ts)
  and [SDK reference](https://platform.claude.com/docs/en/agent-sdk/typescript).
  Installed CLI version was read from the project-owned package metadata.
- [Atlassian ADF schema](https://go.atlassian.com/adf-json-schema).
  Empty paragraph/heading/code-block content is optional; doc and tableRow permit
  empty arrays; other supported structural containers require nonempty children.

## Executed verification

The independent suite ran **before production edits** and returned exit 1:
`tests 5`, `pass 0`, `fail 5`. Permanent tests were then added and executed RED
before each defect's production fix, followed by GREEN. Further type-coercion and
inherited-key checks were also reproduced RED before fixing them.

Final commands and actual results:

```text
node --import tsx --test tests/ai*.test.ts tests/jira*.test.ts
exit 0
ℹ tests 191
ℹ pass 191
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

node --import tsx --test artifacts/review-adapters/independent-regressions.test.ts
exit 0
ℹ tests 5
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

npm exec -- tsc --noEmit
exit 0 (no diagnostics)
```

The unchanged independent harness regenerates
`artifacts/review-adapters/independent-observations.json`; its final observation
reports escaped reflection as `communication_error/credential_reflection`, all
three reserved addresses denied, all three audited event cases rejected,
unsupported auth as `auth_invalid`, and malformed ADF as `partial` with the exact
content pointer. Its original audit/review code is unchanged. This document is
the permanent fix/test report; it is not a fabricated model response or live-account
smoke result. Full-project integration/review remains the parent integration task.

An intermediate typecheck saw concurrently unfinished core test exports and two
new harness socket-type errors. The harness now uses `Duplex`; the final whole
project typecheck returned no diagnostics. Direct `.bin/tsc` invocation was
blocked by the tool's gateway-protection check; the ordinary `npm exec` command
ran successfully. No service/root or isolation changes were used to resolve it.

## Isolation and inference release gate — unchanged

The actual independent sandbox probe still returns:

```json
{
  "backend": "linux-bwrap",
  "available": false,
  "runtimeVerified": false,
  "blocker": "Kernel denied namespace or loopback setup (EPERM); no unsandboxed fallback."
}
```

No authentication attempt or real inference was performed. Existing tests using
synthetic processes/credentials are explicitly harnesses, not model results.
The probe's child is `Node -e`, **not** the mounted production launcher/native
engine. Even a successful probe on a namespace-capable host would not prove that
engine runtime files/libraries or positive TLS-through-CONNECT execution work.
No missing-production-runtime-file defect was demonstrated here.

Keep the fail-closed gate. A separately authorized namespace-capable host must
exercise the actual mounted production launcher/native engine, positive and
negative egress, config-autoload denial and descendant cleanup. Each selected
provider/auth mode then needs an operator-authorized real smoke. Positive real
inference remains unavailable here; do not bypass bwrap or broaden host access.
