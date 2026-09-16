# Simple setup: Live integration

## Production wiring

- Each `LiveAPI` owns one engine setup service, initialized from the trusted `PRCE_AI_CONFIG` settings file, and one `SourceBridge` sharing its private LocalStore.
- GET `/api/engines/setup` discovers/statuses engines. POST accepts only `{action:"rescan"}` or `{action:"reuse-auth",providerId:"codex",candidateId}`. Unknown fields/actions, query parameters and browser-selected executable/auth/config paths are rejected. The existing HTTP session, exact Host/Origin, CSRF, JSON object/content-type and byte-limit gates remain in front of these routes.
- Both PR and selected-code jobs resolve the selected engine configuration immediately before `executeAnalysis`. A small necessary interface extension adds a trusted `config?: AIConfig` option to `executeAnalysis`, forwarding it into the existing `runAnalysis({config})` adapter. No alternative pipeline or fallback runner was introduced. Valid cached-result reads do not resolve configuration or start models.
- The Live engine controls mount `EngineSetupPanel` through a typed RequestInit adapter to the existing CSRF-aware API wrapper. Provider/model selection, handoff scope, transmission consent, audit consent, budgets and cache behavior remain intact. PR and Q&A buttons require the selected engine's readiness. Refresh starts fail-closed; failed refresh removes stale ready text and leaves analysis disabled.
- SourceBridge handles Jira connect/settings before legacy candidate routes. Snapshot capture now uses its session-bound `capture` method. Closing LiveAPI closes Jira sessions, aborts active jobs, clears GitHub sessions and calls an optional engine-service close hook.

## Verification

TDD observed `/api/engines/setup` returning 404, pipeline config arriving undefined, the absent Live setup panel, and stale ready text after a failed probe before the respective fixes.

- `npm run build`: passed (existing ReactFlow `use client` bundler warning only).
- `npm test`: **696 tests; 686 passed, 10 skipped, 0 failed**.
- `npm run test:e2e`: **16 passed**. This is the actual suite count, not an estimated target.
- `git diff --check`: passed.
- `tests/simple-setup-integration.test.ts`: real loopback HTTP security checks; real TLS Jira-shaped fixture → onboarding → manual candidate → authenticated snapshot capture → persisted readback → restart without restored credentials; PR and Q&A pipeline configuration/cache checks with an explicitly FAKE runner/setup.
- `tests/e2e/engine-setup.spec.ts`: actual browser/session/CSRF HTTP with trusted FAKE setup dependency; discovery → explicit reuse → enabled analysis → failed rescan → disabled analysis; navigation makes no inference calls. Existing V3 HTTP browser tests still exercise PR tour → Q&A → tour, status, cache, reload/back and cancellation.
- Legacy intercepted UI tests now explicitly provide FAKE setup statuses rather than depending on host readiness. Legacy GitHub selectors open the advanced form. Legacy Jira settings coverage uses the real protected advanced API and verifies reloaded UI; separate simple Jira and GitHub browser tests use real HTTPS fixtures.

## Limits / follow-up interface blocker

Actual credential-free discovery on this Linux host returned both engines `installed:false`, `ready:false`, `inferenceVerified:false`, with `cli_missing`, `sandbox_unavailable`, and `auth_required`. No real account or model inference was exercised. TLS fixtures are not live Jira/GitHub accounts; FAKE setup readiness is not isolation evidence.

`createEngineSetupService` currently has no production `close` method, and `probeProviders(config)` has no AbortSignal parameter. Integration calls an optional close hook, but cannot immediately cancel discovery through the current interface. Existing underlying process probes remain bounded (including the isolated auth-status process's 10-second deadline and scratch cleanup). Adding immediate shutdown cancellation requires an engine/probe-owner interface change; no discovery, sandbox, auth or platform guard was weakened here. macOS 26 confinement and actual provider entitlement remain separate verification gates; Claude Keychain reuse remains unsupported.
