# Core status — 0.3.0 integration / historical 0.2 handoff

## Current 0.3.0 integration

The actual Live route now invokes `executeAnalysis → runPipeline → official ai.runAnalysis` with a server-private runner/config. Full V3 output and its exact validationContext are persisted and revalidated on reload; private namespaced chunk/stage caches participate in retention/delete. Engine, source, prompt/schema/context/parser/planner/adapter identities are included. `createApp`/LiveAPI accept trusted `runner` and `versions` test seams, never browser JSON.

Live renders grounded fields, source/code discrepancies, explicit StoryEdges and inferred relations, fixed head tour identity/primary new evidence, independent PR/Q&A caches and URL restoration, process versus analysis status, missing context, per-stage coverage and optional same-engine audit. The optional audit has explicit extra-call consent. Additional-parent evidence displays its actual captured parent tree; Q&A at that alternate comparison is explicitly unsupported instead of silently remapped.

The current release matrix is [RELEASE-0.3.md](RELEASE-0.3.md); fresh whole-suite/build/browser/public/probe evidence is [TEST-RESULTS.md](TEST-RESULTS.md), `artifacts/integration-final-*`. Root integration adds `live-pipeline.ts`, `live-grounded.tsx`, V3 API/browser fixtures and the no-auth guard script. It preserves original core/collector/AI/Jira fixes and does not modify the independently owned V3 internals.

**External:** no authenticated GH/GHE/Jira account or real model inference verified; native CLI features detected, but host namespace EPERM/auth absence remain fail-closed. macOS AI is unsupported (adapter not implemented), not merely untested. Full product acceptance, semantic quality and a global independent security approval are not claimed. Source packaging is handled separately by the parent.

## Historical 0.2.0 handoff (not current test totals/contracts)

Verified 2026-09-14 UTC in `/home/ubuntu/development/pr-context-explorer`, package 0.2.0. This is a runnable implementation and tested integration path, **not a claim that every master acceptance criterion is production-verified**.

## Acceptance matrix

| Area | Implemented and exercised | Remaining boundary |
|---|---|---|
| GitHub/GHE configuration | Explicit deployment/Web/API/version/account; official gh token or dedicated env name; exact /user match; source/URL/redirect validation | Authenticated personal/enterprise account and gh auth not exercised; corporate endpoint/version policy must be supplied |
| PR listing | Authored/review-requested; repo/org/author/state/draft/text filters; page/1000 cap/incomplete/rate-limit distinction; intercepted actual client tests | Actual authenticated user's list requires approved credentials |
| Git snapshot | App-only bare fetch; public real GitHub smoke; fixed base/head, body/revision race rejection, same-host fork fallback; real DAG/tree metadata and all-parent diffs | Arbitrary GHES fork permissions, deleted fork behavior and huge pack resource limits need field testing |
| Git correctness | Nonlinear parents, explicit root empty-tree, shallow partial, exact rename lineage, tombstones/revert, quoted UTF8/tab/quote hunk paths, unsupported/binary/large coverage | Multiple merge-base policy implemented as unavailable but complex criss-cross fixture not independently exercised; identical-blob rename ambiguity is not fully resolved |
| Sources/Jira | Standalone Cloud/DC adapters integrated through core bridge; UI settings, candidate provenance, exclusions/manual links, optional real capture, raw+normalized/field/hash/time/source refs; immutable re-versioning | No private Jira access here. Optional comments/parent/related adapter scope not exposed in core UI |
| Local persistence | Private atomic JSON/config/snapshot/analysis/candidate stores; scoped keys, expired read rejection, startup JSON/Git retention, explicit delete; tested | No SQLite transactions, encryption, multi-process admission lock or durable active-job resume; same-user/root outside threat boundary |
| Local API | Loopback/exact Host/Origin/session/CSRF, 16KiB JSON limits, safe assets/no-follow/path allowlists; real HTTP tests | Independent penetration/security review pending. Git collector not a full OS sandbox; remote read-only operations only |
| Live UI | Config save/verify, list/URL/job errors/cancel, cached workspace, real phase/graph/code/source/coverage, explicit model/consent/run, selection-only Q&A, tour/read/resume/back/reload with no automatic run | Semantic tour quality requires actual engine run. No complete inferred-edge editor or independent layout quality evaluation. Browser Use visual backend blocked; Playwright screenshots/DOM/console captured |
| Real AI integration | Calls standalone `probeProviders` / `runAnalysis`, server-owned private config, prompt/schema/selected context, post-output refs; no mock fallback. Actual installed CLI probes executed | Current kernel namespace EPERM and no authorized engine auth: actual inference intentionally blocked/unverified |
| Output validation | Strict generalized v2 envelope; revision/path/blob/side/range, PR/commit/Jira version/content, inferred rationale, prerequisite/file/requirement/supplied evidence checks; no execution-result flags | Consolidated UI envelope rather than all five full reference schema families. Semantic support audit, hallucination/quality evaluation not performed |
| Verification | `npm test`: 98/98. `npm run build`: success. Chromium 7/7. Actual public PR smoke successful, no model transmission. Root npm audit 0 advisories | Private/GHE/Jira/model/macOS checks and fresh independent review remain |

## Files / ownership

Core modules added: `github.ts`, `transport.ts`, `store.ts`, `ingest.ts`, `live-git.ts`, `live-analysis.ts`, `live-api.ts`, `settings.ts`, `source-bridge.ts`. `git.ts` exports/fixes C-quoted hunks, `http.ts` adds protected Live API, `index.ts` loopback/umask, `provider.ts` demo-only labeling. `src/live.tsx` and `src/source-ui.tsx` integrate real modes; `main.tsx` retains demo and links to Live. Package/lock 0.2.0, scripts, isolated Playwright data, own core/integration tests and root docs updated. **No writes to `src/server/ai/`, `src/server/jira/`, ai*.test.ts, jira*.test.ts or their owned adapter docs.**

## Narrow integration interfaces

- `createApp(port, {dataDir?, dist?, client?, ingest?, execute?, probe?})`; dependency injection is trusted server/test-only, not request JSON.
- `GitHubClient(connection, {transport?, credential?})`: `verify`, `list`, `pull`, `pages`; transport only issues GET. Runtime defaults are real HTTPS and official/env credential resolution.
- `ingestPull(connection, url, dataRoot, {signal?, onProgress?, ...test seams}) → LiveSnapshot`.
- `collectGit({barePath, baseSha, headSha, identity, pr, limits?, signal?, onProgress?}) → LiveSnapshot`; no browser local repo path API.
- `live-analysis.ts`: `buildContext`, `liveOutputSchema`, `validateLiveOutput`, `executeAnalysis`, `probeEngines`. AI module is loaded dynamically. Config is read from `PRCE_AI_CONFIG` only and passed as `request.config` / `probeProviders(config)`.
- `source-bridge.ts`: `validateJiraSettings`, `discoverForSnapshot`, `editCandidates`, `captureForSnapshot`. Uses actual standalone Jira exports now present. Core endpoints/settings/UI are wired; failures remain optional source status.
- Evidence navigation for selected Q&A includes returned `selectionEvidence`; analysis metadata is not model-authored. Default `provider.ts` classes are exclusively demo capability cards; real execution is `live-analysis.ts`.

Route table and schema details: `OUTPUT-CONTRACT.md`. Security/resource limits: `SECURITY.md`. Exact fresh outputs: `artifacts/core-*.log`. Browser sample uses public `.data/browser-smoke`; its screenshots predate the final collector version salt but pin the same real base/head. Temporary server was stopped. Tests now use `.data/e2e-live`, and initial test-only records were removed from default user data.

## Next authorized checks

1. Parent performs independent core review; no Git repository exists at app root, so no commit was created.
2. Supply approved GitHub/GHE configuration and auth, then verify /user and a scoped authored/review-requested PR. Test same-host fork, SSO, real custom CA/VPN separately.
3. Supply optional Jira endpoint/env credential/mapping and verify candidate/field/time/source behavior without remote writes.
4. Resolve namespace isolation on a suitable host without disabling the guard. Supply an explicitly approved engine credential path in private config. Select an actual permitted model and transmission scope, then assess returned semantics/tour quality. No other-service credentials were accessed.
5. Add complex criss-cross/rename ambiguity/resource-isolated huge-pack testing and complete schema-family/semantic-audit work before claiming full Stage 5 completion.
