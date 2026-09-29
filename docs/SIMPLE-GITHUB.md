# Simple GitHub / GHES connections

The default form requires only **Web URL** and **Personal access token (PAT)**.
“연결 확인 및 저장” calls the existing authenticated loopback API (session cookie,
Origin validation and CSRF header), verifies `GET /user`, and saves non-secret
connection metadata only after success. Account and connection ID are not user
inputs. The generated ID binds canonical Web/API host and the authenticated
numeric user ID; reconnecting the same account preserves its opaque session
reference so existing host/account cache identities remain stable.

## Endpoint and version behavior

- `https://github.com` → `https://api.github.com`.
- `https://TENANT.ghe.com` → `https://api.TENANT.ghe.com` (**Enterprise Cloud**, not
  Enterprise Server). An explicit advanced same-host root API override is allowed
  only after successful `/user` verification; no redirect is used for discovery.
- An explicitly entered corporate HTTPS DNS URL → same host plus `/api/v3`.
  A registered path such as `https://git.example.com/github` is preserved as
  `https://git.example.com/github/api/v3`; PR URL validation preserves that path.
- `X-GitHub-Api-Version: 2022-11-28` is the documented request default, **not a
  claim that every GHES release supports that version**. Advanced API URL and
  request version overrides remain validated. API URLs cannot send a credential
  to an unrelated host. Unsupported servers fail closed.
- GHES server version is taken only from a valid `X-GitHub-Enterprise-Version`
  response header. Missing/invalid headers display “알 수 없음”; no version is guessed.
- Corporate DNS/private-network endpoints are contacted only when explicitly
  supplied by the user. There is no automatic network scan or URL-content-based
  endpoint discovery. Existing transport restrictions block localhost/IP input,
  DNS loopback/link-local destinations, insecure TLS, and unsupported proxy
  configurations. Use approved direct/VPN access and `NODE_EXTRA_CA_CERTS`.

Official references:
- [REST API getting started / cloud tenancy API URL and version example](https://docs.github.com/en/enterprise-cloud@latest/rest/using-the-rest-api/getting-started-with-the-rest-api)
- [PAT authentication and 401/403/404 behavior](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api?apiVersion=2022-11-28)
- [Get the authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user)

## Token lifecycle and security boundary

PAT entry is a password input, cleared when submitted (including failures).
There is no browser-storage, URL, environment-variable or disk token persistence
in the browser. The desktop app can optionally persist the PAT across restarts:
the simple form exposes an **이 컴퓨터에 PAT 기억하기** checkbox (default on) whose
value is sent as the optional `remember` field of `POST /api/connections/connect`.
When enabled, a successful verification stores the PAT in the macOS Keychain
(service name `PR Context Explorer GitHub PAT`) or, on other platforms, in
`<data folder>/github-credentials.json` with file mode `0600`. Set
`PRCE_GITHUB_CREDENTIAL_STORE=keychain|file|off` to force a store, where `off`
disables persistence. Deleting a connection removes its stored PAT with it; when
the checkbox is off the PAT stays in process memory only, as described above.
The server stores session tokens in `github-session-secrets.ts`, process memory
only; configuration stores only a random opaque reference. UI says **앱 종료 시 삭제**
when the PAT is not remembered. Closing the local server discards the in-memory
session only: a remembered PAT is restored on the next start, while deleting a
connection also removes its stored PAT. A credential-store failure never fails
the connection. If forgetting or deleting the stored PAT fails, the view keeps
reporting `remembered: true` (the PAT may still be on disk) and
`DELETE /api/connections` reports `credentialRemoved: false` alongside
`deleted: true`. Reconnecting an already stored connection with remembering off
and a failing delete likewise keeps `remembered: true`, so the previously stored
PAT can be restored after a restart; delete the connection or retry to clear it.
After restart a non-remembered connection reports `credentialState: "required"`;
re-enter the PAT, rather than pretending saved metadata restores authentication.
Connection views additionally carry `remembered: boolean` to indicate whether the
PAT is restored automatically after restart.
The browser and HTTP request necessarily hold the supplied token transiently;
JavaScript cannot promise physical zeroization of immutable strings.

`resolveCredential` handles session references, so subsequent existing verify,
list, PR collection and Git operations use the PAT without putting it in model
input or service credential environment variables. Existing CLI/env/public
connections are still supported under the collapsed legacy advanced settings.
No Electron vault integration is used; optional persistence relies only on the
OS keychain or the permission-restricted file described above.

Redirects are rejected, never retried on another host. Onboarding errors are
fixed generic messages, never remote response bodies, headers, URLs or thrown
exceptions. GitHub responses with token reflections in headers, raw bodies or
JSON-decoded nested fields/keys are rejected before return. The model receives
neither PATs nor onboarding response bodies.

## API

`POST /api/connections/connect`:

```json
{"webUrl":"https://github.com","token":"<human-entered PAT>"}
```

Optional: `apiUrl`, `apiVersion`. Returns HTTP 201 with `{connection}` metadata
including read-only `account`, generated `id`, and `credentialState: "session"`.
Do not log this request body. Existing `POST /api/connections` is reserved for
legacy non-secret connection settings and rejects session-reference submission.

## Verification

- `npx tsx --test tests/github-simple*.test.ts tests/github.test.ts tests/live-api.test.ts`
- `npm run build`
- `npx playwright test tests/e2e/github-simple.spec.ts`

The browser test runs an actual loopback app/session/CSRF path and a real local
HTTPS GitHub-shaped fixture with certificate verification enabled. It uses an
explicitly **FAKE** PAT, tests default fields, automatic account/version display,
cleared input, reload, browser storage absence, CSRF denial, 401/403 (SSO), 407,
and redirects. No core auth route is intercepted by Playwright. Trusted
server-side transport injection maps only the fixture request to local TLS;
production DNS/TLS restrictions are not weakened. These tests do not establish
that any real user account, PAT, GHES installation or proxy is configured.
