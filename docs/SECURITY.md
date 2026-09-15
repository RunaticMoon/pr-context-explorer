# Security boundary — Demo + Live

## Local server

`index.ts` sets umask 077 and binds 127.0.0.1. Exact `127.0.0.1:<port>` Host, optional exact Origin, and cross-site Fetch Metadata rejection apply to all routes. Session creation additionally requires exact Origin. All API routes require a bounded in-memory 8-hour HttpOnly SameSite=Strict session; POST/DELETE also require exact Origin and an independent fixed-length CSRF header. The loopback HTTP cookie intentionally is not Secure; this is not a public TLS deployment.

Request JSON is at most 16 KiB, JSON object only, with content type checks, bounded URL/headers and HTTP deadlines. No arbitrary filesystem route exists. Static assets are an allowlist of actual regular build files; symlink entries/realpath escapes are refused. CSP blocks remote images/scripts/connect targets, object/embed, framing and base URLs. React renders source as literal text, not source HTML or Markdown. No telemetry.

## Credential-bearing collectors

GitHub config contains endpoint/type/version/account and a credential *method*, not a token. Dedicated `PRCE_` environment names or official `gh auth token --hostname` are supported. Existing gh authentication is used only when that method is explicitly selected. `/user` must match the configured account; public mode cannot claim an authenticated identity.

Only constructed GET API routes under the paired approved HTTPS API endpoint are used. No redirect is followed. Arbitrary PR URL hosts, URL credentials, encoded/noncanonical paths, IP literals and explicitly resolved loopback/link-local targets are denied. Explicit enterprise DNS endpoints can resolve to corporate private addresses: this is intentional, not unrestricted URL fetch. TLS stays enabled. The Git collector permits only HTTPS, exact approved Web host paths, same-host fork fallback, no redirect, no credential helper/global config/hooks, no recurse-submodule and no source textconv/external diff. Tokens are absent from argv/on-disk git config/model input. Successful HTTP responses reflecting the exact token are rejected; this is not complete DLP.

`NODE_EXTRA_CA_CERTS` supplies approved CA roots. HTTPS proxy support is fail-closed, not silently routed through an unverified proxy. DNS preflight + TLS/host pinning is not a general OS network sandbox for the Git collector; independent penetration testing remains pending.

## Git and model separation

Actual source repositories are never checked out as a worktree and no target scripts/tests/builds are executed. Git's app-only bare cache is distinct from demo fixture generation. Source AGENTS/CLAUDE/MCP/settings are data, not engine runtime configuration.

The model entrypoint receives only bounded PR context or selected code range plus trusted shipped runtime instructions/schema. GitHub/Jira collector environments are not passed to it. Engine authentication paths are read solely from an explicitly chosen private server file (`PRCE_AI_CONFIG`); no browser paths, automatic home credential search or other-service credentials. Standalone AI adapter enforces reviewed CLI flags, namespace/root/egress isolation, safe event parsing, cancellation and process cleanup. It fails closed when runtime isolation cannot be verified. Current host probe reports namespace EPERM, so **real inference is blocked**. Construction/probe/fixture tests do not establish live model entitlement or answer quality.

The Git subprocess wrapper has per-command timeout/output bounds and abort signaling; unlike the dedicated AI runner it does not independently prove full Git-helper descendant cleanup. Large repository pack transfer has no cgroup disk quota. Do not deploy against hostile enormous repositories without resource isolation and follow-up testing.

## Stored state

Private atomic JSON records (0600) under 0700 app directories; app-only bare Git cache; default 30-day retention with startup cleanup, lazy expired-record rejection, explicit deletion. Config persists until deleted. Cache dimensions include host/account/API config, PR metadata/base/head, Jira content, selected scope, provider/model, prompt/schema/parser. No encryption or secure erase claim. Same OS user, root, malicious browser extensions and filesystem races from equally privileged local attackers are outside this boundary. File JSON storage is single-process local persistence, not transactional multi-user SQLite.

Sessions and running job progress are memory-only. Completed validated results are persisted; restart loses active jobs and invalidates sessions. Never report resumed/finished inference after a restart without a persisted result.

## Evidence / output trust

All untrusted model results pass strict JSON schema, output bounds, supplied evidence scope, immutable revision/path/blob/side/range, source field/version/hash, DAG prerequisite and requirement-reference validation. Exact-line existence is not semantic support. `semanticAudit=not_performed`; known execution-claim patterns are defensively refused, but language filtering is not a semantic proof. Target tests executed and external CI queried stay false.

Automated boundary tests, intercepted transports/fake processes, actual public GitHub read-only smoke, and private-account/inference success are distinct evidence categories. Public deployment, firewall changes, credential harvesting and TLS-disable workarounds are not part of this implementation.
