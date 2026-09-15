# Executable output and evidence contracts

## Demo v1

`src/server/contract.ts` preserves Stage 1's strict `MockProvider` schema and validator. That schema is used only for the explicitly identified fixture demo.

## Live v2

`src/server/live-analysis.ts` exports `liveOutputSchema` and `validateLiveOutput`. Strict additionalProperties:false schema requires `schemaVersion=2`, snapshotId, analysisStatus (complete/partial/insufficient_context), limitations, missingContext, grounded statements, tour steps, code explanations and requirementMappings. Provider/model/CLI version, usage, deterministic validation and semantic audit are attached by the trusted execution layer rather than supplied by model claims.

The reference master contracts are consolidated into this UI envelope: overview and phase explanations are grounded `statements`, reading flow is `steps`, selected-code response is `codeExplanations`/statements, and Jira links are `requirementMappings`. Separate full PRAnalysis/PhaseExplanation/GuidedTour/CodeExplanation/EvidenceAudit schema families, inferred graph-edge suggestions and automatic semantic audit are **not all implemented**. No code-safe/global-requirements-satisfied/test-passed field exists.

### Grounding

- observed/inferred statements need existing evidence IDs and a valid phase SHA; unknown needs an explicit limitation; inferred needs a nonempty rationale/limitation.
- Tour steps have unique IDs and previously defined prerequisites (acyclic), an actual target phase/comparison, valid live file IDs and in-scope evidence. Historical phases are allowed only when explicitly named.
- Requirement mappings reference actual collected Jira source IDs; supported_by_code/partial_support/contradicted require code evidence. Statuses also include not_demonstrated and unknown.
- Code explanations refer to validated code evidence. Selected-range Q&A introduces deterministic selection evidence bound to the source blob/side/revision and validates against the full captured source.
- Execution returns are checked against the exact evidence IDs transmitted in that context, not arbitrary unseen repository contents. Context omissions remain explicit.

### Source unions

`live-git.ts` defines code Evidence and discriminated `SourceEvidence.sourceKind=pr|commit|jira` for textual source captures.

Code: snapshotId, selected commitSha, comparisonFromSha, revisionSha, fileId, path, blobSha, old/new side, lineStart/lineEnd, contentHash. Every side/range is validated against that phase's real file state. Deleted contents cite the old comparison tree, never a live node.

PR/commit: sourceId, fieldPath, version, content hash and captured text. PR title/body are matched to captured fields; commit messages to original commit/version. Jira additionally binds approved host, issue ID/key, fetched/updated, capture hash, exact normalized document field pointer and original captured issue. Raw structured Jira source remains in the snapshot. Source text is rendered literally and never treated as instructions.

Deterministic validation establishes existence/location/version, **not that the evidence semantically supports the prose**. Automatic semanticAudit remains `not_performed`. A defensive known-phrase execution claim filter is not comprehensive natural-language verification.

## Coverage / limits

Coverage separates discovered head entries, retrieved text and supported AST files, detailed commits, omissions/unavailable data, API pagination and API ceilings. `targetTestsExecuted=false` and `externalCIQueried=false` are factual collection flags. Unsupported static languages can have retrieved source without analyzed AST. Byte/tree/phase caps, binary/generated/large/LFS/submodule/symlink and shallow/ambiguous ancestry are explicit; partial collection cannot validate as complete.

## Local API (all session-protected; POST/DELETE require exact Origin + CSRF)

| Route | Purpose |
|---|---|
| POST `/api/session` | exact-origin bootstrap; HttpOnly session plus independent csrf |
| GET/POST/DELETE `/api/connections` | metadata/env-name/gh GitHub connections |
| POST `/api/live/verify` | authenticated `/user` account match |
| POST `/api/live/list` | authored/review-requested filters + bounded page |
| GET/POST `/api/live/snapshots` | saved inventory / explicit ingestion job |
| GET `/api/live/snapshot?id=<hash>` | exact persisted snapshot + stale flag |
| GET `/api/live/job?id=<id>`; POST `/api/live/cancel` | bounded progress / cancellation |
| GET `/api/live/capabilities` | installed engine/isolated auth blockers; no inference |
| POST `/api/live/run` | explicit provider/model/scope/consent; validated cache or job |
| GET `/api/live/analysis?key=<hash>` | persisted result; never runs a model |
| POST `/api/live/compare` | only known pinned snapshot revisions; arbitrary diff labeled |
| DELETE `/api/live/cache` | explicit local-cache confirmation; connections retained |
| GET/POST `/api/jira/settings` | optional registered Jira endpoints and env names |
| POST `/api/jira/candidates` | bounded source discovery, no remote fetch |
| POST `/api/jira/candidates/edit` | local manual association/exclusion, provenance retained |
| POST `/api/jira/capture` | read selected Jira candidates; new immutable input version |

`GET /api/snapshot` is the original demo endpoint only. No browser-supplied file/executable path, transport override, arbitrary URL fetch or remote write endpoint is exposed.
