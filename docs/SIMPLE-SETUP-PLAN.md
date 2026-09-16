# Simple connection and local engine setup

## User-requested change

Replace implementation-oriented mandatory setup fields with actual connection discovery. Keep internal host/account/revision scoping intact rather than deleting the information it needs.

### GitHub

Default inputs: deployment selector, Web URL, PAT. Derive the conventional API origin/path; verify authenticated identity before storing account binding. API version/custom routes/server metadata move to advanced/read-only diagnostics. No guessed GHES version. Existing gh/environment/public connections remain compatible.

### Engines

Detect installed local Codex/Claude through bounded trusted candidates; show installation, version, authentication, feature compatibility and confinement as separate statuses. Selection/discovery must not run model analysis. Explicit reuse of local login must feed the existing isolated provider pipeline, never a mock or alternate provider. Unknown versions, unsupported credential storage and OS isolation must be reported, not silently bypassed.

### Jira

Cloud (including Enterprise cloud plans) and self-hosted Enterprise/Data Center remain different adapters. User Web URL determines conventional API route including context path. Private issues still require credentials: Cloud email/API token, Data Center PAT. Advanced mappings and nonstandard deployments remain available. Account context comes from verified identity when available. Discovery cannot forward credentials across redirects/hosts.

## Secret handling default

New form credentials are session-only by default and explicitly labeled as cleared on app/backend restart. Password fields are cleared after submission; no browser persistence, server JSON secret persistence, logs, model inputs, target repository configuration, or CLI subprocess environment inheritance. Permanent credential storage is not implied. Existing TLS/Host/Origin/session/CSRF restrictions remain.

## Acceptance

- Basic GitHub/Jira connection UI no longer requires technical API/account/version fields.
- Real local HTTP/API integration proves default discovery and account binding using explicitly synthetic upstream HTTPS fixtures.
- A restart cannot appear authenticated after ephemeral secrets are cleared.
- Local engine setup status and selection are wired into actual analysis, with transmission consent preserved.
- Browser E2E covers secret non-persistence, connect/edit/reconnect/error and discovery status.
- Whole regression/build and isolated packaged ZIP installation gates remain required.
- Real enterprise login and model inference are separate external gates; no fabricated success.

## Ownership

GitHub adapter/forms, Jira adapter/source panel, and engine discovery/setup are isolated implementation workstreams. Parent integrates engine routes/panel, reviews credential boundaries, performs full tests and actual Mac verification before release. Branch: `feat/simple-connections`, based on released `v0.4.1` main.
