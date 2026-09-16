# Simple Jira onboarding

Integration contract for LiveAPI owner (Jira agent does not edit live-api.ts):

- Import `SourceBridge` from `./source-bridge.ts`.
- Construct one `SourceBridge(this.store)` per LiveAPI after LocalStore construction, retain as `jira`.
- Before existing Jira routes: `const jiraReply = await this.jira.handle(method, url, body); if (jiraReply) return jiraReply;` (handles settings + connect only).
- Replace `captureForSnapshot(...)` call with `this.jira.capture(...)` (same arguments/options; binds ephemeral Jira credentials before adapter access).
- Call `this.jira.close()` from LiveAPI.close().
- Optional trusted tests: SourceBridge constructor second argument accepts JiraAdapterDependencies; no browser transport override.

Route: POST `/api/jira/connect`; JSON `{ deployment: 'cloud'|'data_center', webUrl, authentication: 'token'|'anonymous'|'env', email?, token?, advanced?: { apiBaseUrl?, customCaPem?, projectKeys?, acceptanceCriteriaFields?, projectKeyPattern?, credential?: {kind:'env',variable,scheme} } }`. Returns safe `{ settings, summary }`; failures return fixed status/reason, never submitted credentials. GET/POST `/api/jira/settings` remains supported for existing environment-reference configurations.

Cloud includes Atlassian's Enterprise **plan**. Enterprise Server/Data Center is a distinct deployment. Cloud uses same-tenant REST v3 + Basic email/API-token; Data Center uses REST v2 + PAT Bearer. Account identity is read from `/myself`; server version only from `/serverInfo`. Anonymous mode explicitly has no verified account. No credential fallback to api.atlassian.com; scoped Cloud tokens requiring that host are not supported by simple onboarding.

Tokens exist only in process memory; never browser storage/config/snapshot/model payloads. Closing the app forgets them; reconnect after restart. TLS verification is never disabled; explicit CA bundles are supported. The entered HTTPS origin is explicitly registered, including intranet/loopback endpoints; no global network scan or inferred origins. Redirects are rejected. Proxy environments require approved direct/VPN access or trusted server transport configuration.

## Verification and limitations

Tests use local HTTPS protocol fixtures with ephemeral self-signed certificates and fake credentials, **not a live Jira account**. `tests/jira-onboarding-tls.test.ts` exercises connect, persisted settings, real authenticated issue capture, custom CA verification, redirects, HTTP authentication errors, escaped Basic-token reflection, and session destruction. Existing bounded JSON/UTF-8, ADF, credential reflection, discovery/provenance and transport suites remain in place. `tests/e2e/jira-simple.spec.ts` includes both form expectations and a real browser-to-loopback-to-HTTPS connection test (requires the LiveAPI hook above). Rebuild before browser tests: the server serves `dist`, not source TSX.

- Normal Cloud email + conventional API token and Data Center PAT are supported. No live-account validation was performed.
- Simple Web URL supports HTTPS origin and Data Center `/jira`; issue/page URLs are rejected, not silently rewritten.
- Advanced API mapping is same-origin only. Existing manually configured env-based cross-origin adapters remain supported; simple onboarding does not implicitly forward credentials across hosts.
- No proxy discovery, OAuth/scoped-token cloud-ID discovery, network scanning, or TLS bypass.
- Server version is optional and read only from actual `serverInfo` response. API version is the selected deployment's documented route, not an invented server version.
- Anonymous onboarding validates `serverInfo` reachability but does not claim a verified user or permission to any particular issue; issue permission is checked during explicit capture.
- Existing `tests/e2e/live.spec.ts` has old Jira account/API/ID form selectors and must be migrated by its owner to the simple flow or advanced API settings setup.

Official references:
- https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/
- https://developer.atlassian.com/server/jira/platform/rest/v10007/
