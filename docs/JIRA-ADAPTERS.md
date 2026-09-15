# Jira read-only adapters

Standalone server-only implementation, exported by `src/server/jira/index.ts`. It imports no core `Snapshot`, AI provider, UI, or target repository code. Core owns persistence, requirement ↔ code mappings, user selection and PR-only analysis continuation.

## Public integration API

```ts
// Types are exported alongside the concrete implementation.
discoverJiraCandidates(input: DiscoveryInput, config: DiscoveryConfig): CandidateDiscovery
addManualJiraCandidate(discovery, { connectionId, key, note? }, config): CandidateDiscovery
setJiraCandidateExcluded(discovery, candidateId, excluded: boolean): CandidateDiscovery

new JiraCloudAdapter(connection: JiraConnection, dependencies?: JiraAdapterDependencies)
new JiraDataCenterAdapter(connection: JiraConnection, dependencies?: JiraAdapterDependencies)
adapter.capture(issueKeyOrId: string, options?: JiraCaptureOptions): Promise<JiraCaptureResult>

captureJiraCandidates(candidates, adapters, { maxCandidates?, ...captureOptions }?): Promise<JiraBatchCapture>
normalizeJiraDocument(value: JsonValue | undefined, pointer: string): JiraDocument
```

`JiraReadAdapter` exposes only `readonly site: JiraSite` and `capture`. Cloud uses `/rest/api/3/issue/{issueIdOrKey}`; Data Center uses `/rest/api/2/issue/{issueIdOrKey}`. The classes reject mismatched `deployment`. Separate exported `JIRA_CLOUD_ISSUE_SCHEMA` / `JIRA_DATA_CENTER_ISSUE_SCHEMA` are runtime-compiled with AJV. Unknown response properties remain in raw source; Cloud issue descriptions must be ADF documents/null, DC descriptions strings/null. Missing optional fields remain unavailable instead of invented empty content. API field/plugin differences outside these schemas return an explicit error or document-level partial coverage, not fabricated text.

### Server-owned configuration

```ts
interface JiraSite {
  id: string;                         // stable connection ID, ASCII [A-Za-z0-9_-], 1–80
  deployment: 'cloud' | 'data_center';
  webBaseUrl: string;                  // explicit approved HTTPS instance/context root
  apiBaseUrl: string;                  // explicit approved HTTPS API context root, BEFORE /rest/api
}
interface JiraConnection extends JiraSite {
  accountContextId: string;            // opaque non-secret account/permission cache context
  credential?: JiraCredential;
  acceptanceCriteriaFields?: readonly { id: string; label?: string }[];
  projectKeyPattern?: string;
  customCaPem?: string;                // server supplied PEM, never a source-provided path
  limits?: { timeoutMs?: number; maxResponseBytes?: number; maxTotalBytes?: number };
}
```

Examples of endpoint *shapes*, not provisioned connections: Cloud tenant web/API roots can match; a configured OAuth gateway API root may include `/ex/jira/{registered-cloud-id}`. DC web and API roots can both include `/jira`, or use independently registered hosts. Do not include `/rest/api/2` or `/rest/api/3` in `apiBaseUrl`. No host, cloud ID, account, token or field ID is guessed or discovered from issue links. Registering private/VPN endpoints is allowed only through trusted server configuration; do **not** accept this structure directly from browser/source payloads. The local API must separately authenticate changes to the server registry and enforce Origin/Host/session protections.

Credentials are resolved server-side and not part of snapshots:

```ts
type JiraCredential =
  | { kind: 'callback'; resolve: (context: {
        connectionId: string; apiOrigin: string; signal: AbortSignal;
      }) => Record<string, string> | null | Promise<Record<string, string> | null> }
  | { kind: 'env'; variable: string; scheme: 'Bearer' | 'Basic' };
```

The callback must return **exactly one Authorization header**, with `Bearer <value>` or `Basic <value>`. Header names are case-insensitive. Cookie, Host, proxy authorization, extra headers, control characters and empty credentials are rejected. For env bindings the variable is an explicit server-configured name; its value is the Bearer token or pre-encoded Basic credential, **without** the scheme. Secret acquisition, account verification, OAuth login/refresh and OS credential storage are caller responsibilities. Callback resolution is inside the capture deadline; honor its AbortSignal. Null, missing env values and failed resolution produce `unconnected`. No anonymous network fallback, cookie login, browser storage, shell command, credential-file search or access to another service's credentials occurs.

### Discovery and provenance

`DiscoveryInput` accepts optional `title`, `body`, `branch`, `commits: {sha, subject, body}[]`, and `explicitLinks: string[]`. Empty commit bodies are retained. Sources retain the exact input text, field path and commit SHA where provided; all occurrence ranges use **UTF-16 code-unit offsets, start inclusive/end exclusive**. No title/body trimming or key case correction occurs.

```ts
const discoveryConfig: DiscoveryConfig = {
  sites: adapters.map(a => a.site),
  projectHosts: { APP: ['registered-cloud'], OPS: ['registered-dc'] },
  projectKeyPattern: '[A-Z][A-Z0-9_]{0,19}',
};
```

`projectHosts` maps a project key to an array of registered connection IDs; multiple registrations intentionally produce separate host-qualified candidates. Unmapped bare keys remain candidates with `host: null, connectionId: null`. Registries reject duplicate IDs, duplicate canonical web roots and unknown mapping references, rather than silently choosing an account/host. Use one active connection per web instance in a discovery registry.

The only pattern grammar is **`[A-Z][A-Z0-9_]{m,n}` with 0 ≤ m ≤ n ≤ 31** (the suffix count after the initial letter). Arbitrary JS regex, flags, alternation, nested repetition and unbounded quantifiers are not accepted. Issue numbers are positive, non-zero-prefixed ASCII decimal strings up to 20 digits. Pattern and URL scheme matching are bounded; sources are capped at 1,000,000 total UTF-16 units, 10,000 source records and 10,000 mapped candidate occurrences. Exceeding a discovery limit throws `JiraConfigurationError`; it never presents a silently truncated candidate list as complete.

Only a registered HTTPS `webBaseUrl + /browse/{valid-key}` link is actionable. Links with unregistered hosts, userinfo, traversal, encoded paths, backslashes, extra path segments or non-HTTPS schemes are rejected. Query/fragment decorations on an otherwise valid link remain in provenance but are never used for requests. URL text is excluded from bare-key scanning, so an unregistered URL cannot be laundered into a mapped candidate. Malformed links remain in `rejectedLinks` with locations and original text. `explicitLinks` entries are link-only, not a request to scan arbitrary bare keys. This is not a generic Markdown parser or Jira redirect/short-link resolver.

A `JiraCandidate` has `{id, host, connectionId, key, excluded, provenance[]}`. The ID is `JSON.stringify([canonicalWebBaseUrlOrNull, exactKey])`; canonical web identity includes scheme/host/port and DC context path. Every repeated occurrence is retained with `{sourceId, fieldPath, start, end, matchedText, method}`. Equal keys on different hosts never merge. IDs do not mean the remote issue exists. On capture, `identity` adds `issueId`, `issueKey`, `connectionId`, `accountContextId`, and `host`.

Manual association is immutable: it appends a `/manual/N` source and provenance, merging only identical host/key identities. Exclusion changes only the excluded flag; it does not erase candidates or their sources. Re-enable explicitly with `setJiraCandidateExcluded(..., false)`. The helpers do not persist or issue network requests.

## Capture contract and states

```ts
type JiraCaptureResult =
  | { state: 'captured'; snapshot: JiraIssueSnapshot }
  | { state: 'unconnected' | 'unknown_or_forbidden' | 'communication_error'; reason: string };
```

- `captured`: valid primary issue with raw source, normalized fields, identity and coverage. Optional reads can still be partial/unavailable.
- `unconnected`: adapter/credential unavailable. A discovered key is not evidence that an issue exists.
- `unknown_or_forbidden`: **identical** result for 401, 403 and 404; neither response body nor status code leaks into the output.
- `communication_error`: timeout, cancellation, redirect, HTTP/rate-limit/network/TLS failure, invalid identifiers/schema/UTF-8/JSON, reflected credentials or size limits. Fixed safe reason codes; raw exceptions, response bodies and credential headers are not returned on failure.

No issue lookup returns `no_data` on 404. **`no_data` belongs to the batch**, meaning no active candidates (including all excluded). `JiraBatchCapture` returns `{state, canAnalyzeWithoutJira: true, items: [{candidate,result}], excludedCandidateIds, omittedCandidateIds, captureHash}`. Its state is `no_data`, a shared homogeneous item state, or `partial` for mixed states/cap omissions. Defaults are 20 active candidate captures, maximum 50. All candidates remain in discovery. Missing adapters return `unconnected`; forged candidate host/key bindings are rejected before contacting an adapter. Failures do not call or block AI: core must continue constructing a PR-only context when appropriate. Batch work is sequential; each candidate has its own per-capture deadline, and callers can cancel the batch with the shared signal.

### Raw/normalized snapshots and evidence

`JiraIssueSnapshot` contains:

- `schemaVersion: 'jira-snapshot-v1'`, `normalizerVersion: 'jira-text-v1'`, deployment and identity.
- `webUrl` built from the registered web root and verified issue key, never response `self` or model-supplied links.
- `source: {rawResponse, raw, sourceHash, fetchedAt, requestPath}`. `rawResponse` preserves the exact accepted UTF-8 JSON body, including whitespace; `raw` preserves the parsed values and unknown fields. Non-JSON responses are not source snapshots.
- `title`, `description`, `status`, `issueType`: `JiraDocument` with `{pointer, present, raw, text, segments, coverage, unsupportedPointers}`.
- `acceptanceCriteria: {fieldId, label, document}[]`, **only** explicitly configured custom fields. No mapping means an empty array; absent/null/empty fields stay distinguishable. Description and comments are never relabeled as acceptance criteria.
- Optional comments, comment page source captures, parent result, related results/references, and their coverage.

ADF traversal extracts literal text leaves, adds structural separators and retains JSON Pointer text segments `{pointer,start,end}` into normalized text. Unknown nodes/unsupported document versions are marked partial, with original source untouched. Normalization has a depth/node budget. DC wiki source is kept literally as plain text; no lossy wiki-to-HTML conversion. HTML-looking strings are still untrusted literal text. Core/UI must use text rendering (e.g. React text nodes), never `dangerouslySetInnerHTML`, untrusted Markdown image/link rendering, or automatic URL loading.

`sourceHash` is lowercase SHA-256 of the exact response bytes, **not** a semantic JSON hash; a whitespace-only source response change can invalidate it. `captureHash` additionally includes identity/account context, field mapping, normalizer version, requested optional scope, optional source hashes/results and coverage, excluding local `fetchedAt`. Comment-only updates and field mapping/scope changes invalidate capture hashes. Comment evidence includes its page `sourceHash` and `pageIndex`; its pointer is relative to that page's `raw`, not the primary issue. Use host/connection/account/issue ID + source hash + pointer for evidence IDs. Core cache keys must also include its own schema/prompt/analysis versions and PR/Git metadata.

`updatedAt` is the untouched server-provided string, or null when absent. `fetchedAt` is local acquisition time. These are current reads, **not commit-time requirements** or an atomic multi-resource transaction. Required identifiers are matched exactly against the response; if Jira resolves an old/moved key to a different key, this implementation fails closed. Reconnect using the verified current key or explicitly provided numeric issue ID.

### Optional bounded scope

```ts
interface JiraCaptureOptions {
  signal?: AbortSignal;
  comments?: { maxComments: number; maxPages?: number }; // 1–100, pages 1–5 (default 3)
  parent?: boolean;                                    // one level only
  related?: { maxIssues: number };                      // 1–10, one level only
}
```

Nothing optional is requested by default. Parent/related scope adds `parent`/`issuelinks` to the primary fields selection and requests linked issues by validated numeric IDs at the **same registered API root**. Related issues deduplicate by issue ID but keep every original link pointer, direction and type. Link `self`, remote links, attachments, inline images and rich-text links are never followed. Related/parent issue captures themselves have no recursive scope. The primary raw response still preserves all returned link metadata even when the related cap omits reads.

Comments use only `GET .../issue/{verified-issue-id}/comment`, generated `startAt`, `maxResults`, and `orderBy=created`; server-provided next links are not followed. Total changes, stalled pages, duplicate IDs, invalid counts or optional failures stop pagination and preserve only validated acquired pages. Coverage is `{state: not_requested|complete|partial|unavailable, retrieved, total: number|null, reason?}`. `complete` is relative to the server's current permission-filtered response, not proof that inaccessible comments do not exist. A missing parent/links field is unavailable; it is not inferred to mean no relationship. Optional failures retain the successfully captured primary issue.

## Transport/security contract

The default uses built-in **`node:https`**, not a mock or third-party HTTP client:

- GET only; no redirect following, retries, writes, proxy environment lookup, cookie jar or arbitrary URL traversal.
- Exact registered HTTPS origin/context binding; request paths and allowed field IDs are generated. Config rejects URL credentials, queries/fragments, traversal/encoded context paths and unsafe patterns.
- Explicit `rejectUnauthorized: true`, certificate/hostname validation, no TLS-disable option. `customCaPem` permits up to eight PEM certificates/65,536 characters, validated at construction. Supplying `ca` uses that custom trust bundle for this connection, not a global trust-store mutation. Proxy/OAuth-login/SSO flows are not implemented.
- One monotonic total deadline spans credential lookup, headers, body reads, normalization and optional requests. Signal cancellation and pending body/request cleanup are enforced. Injected asynchronous operations cannot postpone the returned deadline by ignoring AbortSignal; trusted callbacks should still stop their own work. Synchronous user callbacks cannot be preempted; their elapsed deadline is checked before returning a capture.
- Defaults: 15,000 ms, 1,048,576 bytes per body, 4,194,304 bytes per issue capture across optional requests. Allowed maxima: 120,000 ms, 8,388,608 bytes/body, 33,554,432 bytes/capture. Declared and actual lengths are checked, UTF-8 is strict, JSON traversal is capped at depth 64 / 100,000 nodes, response headers at 16,384 bytes.
- `Accept-Encoding: identity`; unexpected compressed responses fail instead of risking decompression amplification. Non-JSON content types fail. Direct credential reflections in successful response bodies fail closed, rather than altering the original and pretending the result is exact. This is not a general secret-content/DLP scanner.

`JiraTransport` injection is a **trusted server/testing seam**, never browser config:

```ts
type JiraTransport = (request: {
  url: string; method: 'GET'; headers: Readonly<Record<string, string>>;
  signal: AbortSignal; customCaPem?: string;
}) => Promise<{
  status: number; headers: Readonly<Record<string, string>>;
  body: AsyncIterable<Uint8Array>;
}>;
```

A custom transport can undermine the network boundary by itself; it must honor the same HTTPS, TLS, no-redirect, origin and cancellation rules. Tests inject only in-process synthetic Jira responses. `JiraAdapterDependencies.now` is an optional acquisition-clock seam; deadlines always use real monotonic time.

## Core integration example

A compilable version is in `artifacts/jira-integration-example.ts`; it has no execution on import:

```ts
const adapters = connections.map(connection => connection.deployment === 'cloud'
  ? new JiraCloudAdapter(connection) : new JiraDataCenterAdapter(connection));
const discovery = discoverJiraCandidates({ title, body, branch, commits, explicitLinks }, {
  sites: adapters.map(a => a.site), projectHosts, projectKeyPattern,
});
// Apply user-approved manual associations/exclusions to discovery before capturing.
const capture = await captureJiraCandidates(discovery.candidates, adapters, { signal });
const jiraContext = { discovery, capture }; // original sources + all data/coverage states
// Continue PR analysis with zero Jira snapshots when capture.state === 'no_data' etc.
```

Pass only approved context data to the AI runner, not `connections`, adapters, credential functions or the service process environment. Requirement mappings and `supported_by_code` are core output-contract concepts, **not requirements met, tests passed, or verification**. The adapter never claims code support, invokes analysis, runs target tests, or queries CI.

## Verification and limits

Run from the project root:

```sh
node --import tsx --test tests/jira*.test.ts
npx --no-install tsc --noEmit --project artifacts/jira-tsconfig.json
```

`artifacts/jira-01` through `jira-10` red/green logs record observed TDD tracer slices (discovery; discovery security/manual state; normalization; Cloud capture; read safety; DC schema; optional scope; batch continuation; adversarial hardening; endpoint-path ReDoS regression). Regression tests additionally exercise optional pagination/hash/cap behavior. `tests/jira-transport.test.ts` uses ephemeral OpenSSL-generated localhost certificates and real local HTTPS sockets to verify custom CA/hostname rejection, GET-only capture, redirects with a separate sink, body limits and slow-body timeout. It removes its own certificate/key directory on completion. This test requires `openssl` and local loopback sockets.

**No live Jira host/account was supplied; no real Cloud/DC account smoke was performed.** Mock response tests and the HTTPS protocol harness are not evidence of organization-specific Jira/SSO/plugin compatibility. No credentials were retrieved from other services. Root package/lock, core snapshot contracts, UI and target code were not changed by this module. Full-project build/independent integration review remain the parent/core owner's responsibility while parallel work continues.

Official API references consulted for implementation shape (not a live compatibility test):
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
- https://docs.atlassian.com/software/jira/docs/api/REST/9.12.2/ (versioned v2 resource/pagination reference)
