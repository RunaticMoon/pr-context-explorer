# Grounded analysis pipeline V3 — server integration contract

## Scope and verification boundary

`src/server/analysis-v3/index.ts` is an isolated replacement analysis module. It does **not** change the existing AI launcher, Git collector, Jira adapters, routes, UI, package manifest, or V2 contract. The integration owner must wire it into the existing authenticated/consented Live job path. This module is not a claim that the app already uses V3.

The tests use actual immutable Git object fixtures and, where applicable, the existing Jira normalizer with a **scripted transport**. The injected analysis/audit runner is explicitly a deterministic fixture, **NOT model inference or semantic-quality evaluation**. No target source install, test, build, command, CI query, or external model invocation is performed. The module itself has no filesystem, shell, credential, network, or auth-config access; its only imports with runtime effects are its own code, Node crypto/performance, and Ajv. Imports of existing Snapshot/Git/Jira interfaces are type-only.

## Stable public entry point

```ts
import {
  runPipeline,
  PipelineError,
  type PipelineRunner,
  type PipelineCache,
  type PipelineOptions,
  type PipelineResult,
  type V3Output,
} from "./analysis-v3/index.ts";

// Construct ONLY on the server, after the existing explicit provider/model,
// connection, snapshot and data-transmission consent checks.
const runner: PipelineRunner = async (request) =>
  ai.runAnalysis({
    providerId: request.providerId,
    model: request.model,
    schema: request.schema,
    context: request.context,
    trustedPrompt: request.trustedPrompt,
    signal: request.signal,
    onEvent: request.onEvent,
    config: serverOwnedAIConfig,
  });

const result = await runPipeline({
  snapshot, // existing LiveSnapshot, not a reduced/fake DTO
  providerId: "codex", // 'codex' | 'claude', selected explicitly
  model: selectedModel,
  scope: { kind: "pr" }, // or the existing code-scope shape below
  runner,
  signal: job.abort.signal,
  onEvent: (event) => publishJobEvent(event),
  cache: trustedPrivateCache, // optional get/set callbacks below
  audit: { enabled: userOptedIn, failurePolicy: "downgrade" },
  allowHistoricalSteps: false,
});
```

The wrapper must use the existing isolated `ai.runAnalysis` path, which serializes source into stdin, **not source files or shell/CLI arguments**. Do not turn `context` into a tool request. Do not deserialize `runner`, `cache`, configuration paths, `versions`, or arbitrary budget overrides from a browser. Engine credentials remain entirely outside this module. No provider/model fallback exists. A runner reporting a different requested provider/model or `fallbackUsed: true` is rejected; `observedModel`, CLI version, parser version, usage, and other runner metadata are preserved without fabricating values.

Code scope is structurally compatible with V2:

```ts
{
  kind: 'code', commitSha, fileId, side: 'old' | 'new',
  lineStart, lineEnd, question
}
```

A code selection must be contained in actual captured evidence, cover fewer than 500 lines, and have a question no longer than 2,000 characters. The server creates a deterministic `v3-range:` ID when a narrower range is needed; source hash remains the original whole-file hash, and actual range text is independently checked. Code jobs do not generate a tour and never overwrite the PR job result.

### Return shape

- `output: V3Output`: the consolidated, structurally/reference-validated V3 result.
- `processStatus: 'succeeded'`: successful orchestration, **not** sufficient analysis or verified behavior.
- `output.analysisStatus`: independently `complete | partial | insufficient_context`.
- `metadata`: selected provider/model, start/end time, per-stage records with cache key, exact context hash, cache-hit flag, validated/failed state, and original runner metadata; `fallbackUsed: false` describes this orchestrator.
- `deterministicValidation`: `{ status: 'passed', scope: 'schema-and-transmitted-evidence-references', semanticSupportVerified: false }`.
- `semanticAudit`: `not_performed | performed | failed | rejected`, plus scoped audit output/dispositions when available. This is never a global safety verdict.
- `coverage`: explicit task counts, analyzed/failed/not-started chunks, IDs of summaries included in synthesis, cited/transmitted evidence IDs (including validated cache reuse), `currentRunTransmittedEvidenceIds` for actual runner invocations including failed calls, complete omission/unavailability records, original `snapshotCoverage`, and false target-test/CI execution flags.
- `validationContext`: the **exact final synthesis evidence bundle**, including original excerpts/source records, canonical hunk records, source roles, and static edges. Save it with the result for exact-context reload validation; do not rebuild a broader bundle and thereby authorize previously untransmitted IDs.
- `evidence`: planned original/derived evidence records for navigation, not a declaration that all were successfully analyzed.
- `selectionEvidence`: selection-origin evidence for code jobs only.
- `commitOrder`: the collector's actual PR phase order, separate from narrative steps. Baseline is not inserted as a PR commit.

`PipelineError` carries a safe error `code`, `processStatus: failed | cancelled`, available coverage/stage records, and `semanticAudit` for rejection/failure. Examples: `cancelled`, `pipeline_timeout`, `all_chunks_failed`, `synthesis_failed`, `semantic_audit_rejected`, `semantic_audit_failed`, `final_validation_failed`. Never display an exception as a completed analysis. Invalid initial snapshot/scope/schema inputs can also throw ordinary validation Errors before a job has run; handle them as failed validation, not inference.

When **no evidence is available**, no runner is invoked. The server returns explicit deterministic unknown statements with `insufficient_context`, empty tour, and no stage metadata. That is a shortage report, not a fabricated model response.

## Pipeline stages and bounded context

1. **Plan and validate inputs.** Validate snapshot/source identities, unique file/evidence/graph IDs, evidence SHA/path/blob/side/range/content hashes, source originals, Jira capture identity/field/hash/time, and static import provenance. Work exclusively from already captured trees/sources.
2. **File/commit/source chunks.** Prioritize changed head files and changed hunks, then per-commit changes and actual additional-parent comparisons. Include baseline evidence for changed logical files, then strict one-hop direct imports, including captured unchanged dependencies. No recursive import walk or filesystem expansion. Source chunks retain original PR/commit/Jira records and source-role classification. Ranges are bounded, exact IDs deduplicated, and repeated excerpt text is interned by content hash inside bundles.
3. **Validate each chunk separately.** A chunk must return the exact task ID, summary, grounded findings, code explanations, status, and limitations/missing context. Invalid or failed chunks are not synthesized/cached as successful results. Successful independent chunks may continue after a failure, but its omission survives and makes the PR result partial.
4. **Grounded synthesis.** Add validated chunk output **together with its actual original evidence** to a bounded synthesis packet. Merged excerpts are deduplicated. If a summary and its evidence cannot fit together, omit that summary and record it; do not pass source-free claims or invented citation IDs. Synthesis is a separate schema-constrained call, not concatenation of filenames or summaries.
5. **Head-pinned tour.** A separate tour call receives the original synthesis evidence and the grounded synthesis candidate. If that packet exceeds its cap, skip the tour with an explicit omission/partial status rather than dropping evidence silently. Code-scope jobs skip this stage by design.
6. **Optional audit.** Same runner, provider, model, cancellation, and budgets; original candidate and evidence accompany the audit schema. No automatic second-engine check.
7. **Final validation.** Revalidate after server status/omission adjustments and audit transformations. Schema overflow or broken references fail closed; they cannot leave a `passed` result behind.

`ContextBundle.code[]` holds `{ evidence, contentRef, origin }`; `blobs[contentRef]` is the exact range text. `evidence.contentHash` remains the hash of the original whole file, not the excerpt. Origins distinguish `changed_hunk`, `changed_file`, `pr_baseline`, `direct_import`, and `selection`. `sourceRoles[id]` is server-derived (`explicit_acceptance_criteria | source_text`), not supplied by the model.

Canonical `v3-hunk:` IDs hash the whole original hunk, including both comparison SHAs. `originalId` is retained for UI adaptation because the original parser can reuse a hunk suffix across different parents. Never resolve an old-side range against whichever commit happens to be selected in the UI. A second-parent old-side proof is constructed only from the matching already captured parent tree; unavailable parent code is recorded as unavailable, not read from the OS or substituted with first-parent text.

### Default budgets

| Setting                                                  |                                                Default |
| -------------------------------------------------------- | -----------------------------------------------------: |
| `maxChunks`                                              |                                                     48 |
| `maxChunkBytes` (serialized source bundle)               |                                                 32,000 |
| Per-chunk stage envelope cap                             |                                `maxChunkBytes + 8,000` |
| `maxTotalContextBytes` (selected chunk bundles)          |                                              1,200,000 |
| `maxSynthesisBytes` (synthesis/tour/audit stage context) |                                                180,000 |
| `maxOutputBytes`                                         | 180,000; chunk output is additionally capped at 32,000 |
| `linesPerWindow`                                         |                                                    100 |
| `maxCalls`                                               |                                                     52 |
| `callTimeoutMs`                                          |                                                120,000 |
| `totalTimeoutMs`                                         |                                                900,000 |

Budget overrides must be positive safe integers, bounded at four times their default. The existing AI adapter additionally bounds the full prompt/schema/input envelope; these context budgets do **not** claim to be a token estimator. Actual JSON UTF-8 bytes, including escaping, are measured. A single huge/minified line or oversized source is omitted with its identity/reason rather than truncated and falsely assigned the original hash.

All omissions remain in the returned coverage manifest. To keep requests bounded, stage packets include a counted prefix of omission records; output `missingContext` carries a bounded prefix and explicitly refers to the full coverage list. A model returning `complete` cannot erase a planner/chunk/synthesis/tour omission; the orchestrator downgrades it to `partial` (or preserves `insufficient_context`). If server additions exceed the schema cap, the result fails validation rather than silently discarding model-authored limitations.

Cancellation and deadlines use AbortSignal plus monotonic elapsed-time checks. The wrapper must honor abort by terminating the actual isolated CLI process. The orchestrator returns within its deadline even if an injected runner Promise ignores its signal, but cannot kill a process hidden inside an uncooperative custom callback. The deadline also bounds cache callbacks. Cache failure is not an engine fallback.

## Output contract: no free-form important explanations

Every displayed important claim uses:

```ts
type GroundedStatement = {
  text: string;
  kind: "observed" | "inferred" | "unknown";
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
  rationale: string;
  limitation: string;
};
```

The JSON Schema itself and the deterministic validator require nonempty evidence for observed/inferred, non-whitespace rationale for inferred, and non-whitespace limitation for unknown. Every ID must exist in the **transmitted stage bundle**. A line being real does not prove it supports the claim. Known test/CI-success claims are rejected; this limited defensive check is not a universal semantic verifier.

The consolidated contract includes:

- `overview`: oneLiner, problem, statedIntent, inferredIntent, previousBehavior, newBehavior, strategy, nonGoals — all grounded. Stated intent requires original source evidence; inferred intent cannot be observed.
- `changeGroups` and `phaseSummaries`: grounded titles/purposes/before/changes/why/limitations with real file/commit/hunk/graph IDs and comparisons.
- `requirements`: own unique entity IDs, original source IDs, grounded statement, and `explicit_acceptance_criteria | extracted_requirement | interpretation_proposal`. Titles/descriptions cannot become explicit AC. Interpretation cannot become observed.
- `requirementMappings`: five statuses, grounded explanation, many-to-many commits/files/evidence/test-source references. Support/contradiction requires both source and code proof. Contradiction also requires an explicit matching discrepancy.
- `discrepancies`: separate conflicting original source/code ID arrays, explanation citing both sides, grounded resolution, and requirement IDs.
- `codeExplanations`: grounded roleInPR, responsibility, inputsOutputs, behavior, beforeAfter, sideEffects, errorHandling, answerToQuestion; selected evidence and revision/comparison; changed/unchanged/selected-range context kind; typed static/inferred relationships, requirement links, test source evidence, questions, and actual next-reading targets.
- `inferredEdgeSuggestions`: existing files at the stated revision, typed relation, `evidenceSource: 'inferred'`, and inferred/unknown explanation. No static-validation flag; no collision with a supplied static graph edge ID.
- Questions are explicitly `kind: 'question'`, and their question text and rationale remain grounded statements so embedded assumptions cannot escape the contract.
- `tour`: tourId, fixed tourRevisionSha, grounded title/rationale/summary, steps and storyEdges.

A step's title, whyNow, previousConnection, explanation, beforeAfter, relationToGoal, checkpoint questions, nextTransition, and historicalReason all use grounded statements. Its references are checked against targetRevisionSha/comparisonFromSha and transmitted evidence. Default steps target `snapshot.headSha`; historical exceptions require `allowHistoricalSteps: true`, `historical: true`, a distinct valid revision, an evidenced historical reason, and return to head at the end. The orchestrator supplies a deterministic tourId derived from the candidate/selected engine/prompt, and rejects any different returned ID.

Story edges only have `relation: 'next_reading'` and step endpoints. Prerequisites/story edges must point forward in the explicit reading order, enforcing a DAG. They are not code edges. Multiple files per step and repeated files/ranges across different steps are legal. Do not infer development sequence from this order.

## Optional semantic audit

`auditOutputSchema` contains only scoped fields:

- `assessedJsonPointers` targeting actual GroundedStatement objects in the candidate;
- `issues[]`: targetJsonPointer, category, severity, grounded reason, evidenceIds, action (`reject | downgrade | needs_context`);
- `unableToVerify[]`: pointer and grounded reason;
- grounded `scopeSummary`.

Unaccounted important statement pointers are explicitly added to `unableToVerify`. There is no `safe`/`correct` global field. Reject prevents normal output and preserves the audit in `PipelineError.semanticAudit`. Downgrade/needs-context changes disputed statements to unknown, retains the original claim in audit dispositions, and makes analysis partial. Needs-context adds an explicit request; it does not trigger an automatic fetch. Mapping support status is reduced to unknown when its explanation is downgraded. Post-audit output is deterministically validated again.

The default failure policy is `downgrade`: an audit execution/schema failure is visible as `semanticAudit.status: failed` and a partial result. `failurePolicy: 'fail'` rejects the job instead. An unperformed audit stays `not_performed`; a performed audit does not make `semanticSupportVerified` true.

## Cache and reload adapter

`PipelineCache` has trusted `get(key)` and `set(key, CacheEntry)` callbacks, optional `ttlMs` (default ten minutes, maximum 24 hours), and `bypass` to force new inference. Use the existing private app-owned store and retention/deletion controls. This module creates no cache files, selects no storage directory, and claims no at-rest encryption or durable active-job resumption.

Keys include task/stage, connection/account/repository/PR/base/head/snapshot identity, PR metadata and original source/Jira version hashes, selected provider/model, source parser, actual context hash, actual prompt content hash, actual schema content hash, and version dimensions. Optional `versions` keys are `prompt`, `schema`, `parser`, `planner`, and `engineFingerprint`. Pass a known CLI/engine fingerprint when available. A moving model alias without a fingerprint is **not pinned**; use expiry/bypass after model changes. Per-revision IDs are preserved; this cache deliberately does not relabel an old-SHA chunk as a different revision.

Only schema/reference-validated stage outputs are saved. A cached entry is checked for key/version/expiry and **revalidated against the exact current stage context** before reuse. Invalid entries are rejected and recomputed with the same selected engine, never used as fallback. A successful analysis can be partial/insufficient and remain cached; its shortage status is preserved when reapplied. Failed chunks are not cached. Audit cache keys include the exact candidate.

For whole-result reload, retain `result.validationContext` and call:

```ts
validateV3Output(saved.output, snapshot, saved.validationContext, {
  allowHistoricalSteps: savedUserOptIn,
  omissions: [...saved.coverage.omitted, ...saved.coverage.unavailable],
});
```

The caller must also check whole-result engine/version/expiry identity; `validateV3Output` checks output/source references, not the caller's store retention policy.

## V2 UI transition checklist

Do not cast V3 to `LiveOutput` or flatten GroundedStatement into an unmarked string.

| V2 concept                       | V3 source/adaptation                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `statements`                     | Render `overview`, `changeGroups`, `phaseSummaries` and their kind/evidence/rationale/limitation independently.                                 |
| `steps`                          | `output.tour.steps`; `id` retained, `revisionSha` becomes `targetRevisionSha`, `why` becomes `whyNow`, `previous` becomes `previousConnection`. |
| `evidenceIds` in step            | `focusEvidenceIds`; selected code navigation reads the exact returned Evidence revision/side/range.                                             |
| `fileIds` / `prerequisites`      | `focusFileIds` / `prerequisiteStepIds`.                                                                                                         |
| Step title/question/before-after | Grounded components, not bare strings; checkpointQuestions is an array.                                                                         |
| Code `role`/`errors`             | Grounded `roleInPR`/`errorHandling`; no forced observed classification.                                                                         |
| Requirement source ID            | V3 requirement entity ID, then its `sourceEvidenceIds`; never assume every Jira source is a requirement.                                        |
| Hunk ID lookup                   | Use `validationContext.hunks` canonical ID and both SHAs; retain `originalId` only as a comparison-scoped adapter key.                          |
| Static graph                     | Existing collector edges only; inferred suggestions and story edges have separate data/style/labels.                                            |
| Read-state key                   | snapshot + provider/model/result version + tourId + tourRevisionSha, not snapshot alone.                                                        |
| Job succeeded                    | Show alongside output.analysisStatus, deterministic validation, audit status, and missing context.                                              |
| Git AST `coverage.analyzed`      | Keep under snapshotCoverage; use analyzedChunks for completed validated analysis tasks, never call AST files “model analyzed.”                  |
| Current Q&A result               | Keep separate from PR result; preserve scope restoration and do not auto-invoke on navigation/reload.                                           |

Exported pure APIs are `planContext`, `resolveBudgets`, `mergeContexts`, `validateContextBundle`, `validateCodeEvidence`, `validateSourceEvidence`, `validateGroundedStatement`, `validateStage`, `validateV3Output`, `collectStatements`, `referencedEvidenceIds`, `validateAuditOutput`, `applySemanticAudit`, `pipelineCacheKey`, and `trustedPrompt`. Exported schema roots are `groundedStatementSchema`, `chunkOutputSchema`, `synthesisOutputSchema`, `tourOutputSchema`, `v3OutputSchema`, and `auditOutputSchema`. `mergeContexts` is a pure union helper **without its own byte cap**; the orchestrator performs bounded assembly. `applySemanticAudit` expects already validated audit input; the orchestrator performs both validation steps.

## Verification commands and remaining integration work

Run only explorer tests/typechecking, not target repository source:

```sh
node_modules/.bin/tsx --test tests/analysis-v3*.test.ts
node ./node_modules/typescript/bin/tsc --noEmit --project artifacts/pipeline-v3-tsconfig.json
```

RED/GREEN runs are retained under `artifacts/pipeline-v3-*.log`; the final verification receipt records actual counts and commands. Coverage includes contract field mutation, exact source metadata, real Git parent/baseline/import context, narrowed code selection, bounded large input, cache reuse/invalidation/corruption, engine mismatch, partial/insufficient states, cancellation/deadline/call budget, head/history/story invariants, Jira AC provenance, and scripted semantic-audit rejection/downgrade/incomplete/invalid outputs.

Remaining work belongs to the app integration owner: wire authenticated routes/job storage/private cache and the consented runner; render grounded fields/statuses/story/inferred/discrepancy/audit data; preserve exact context on cached reload; add V3 route and browser/E2E fixtures. Actual CLI inference, semantic explanation quality, authenticated GitHub/GHES/Jira deployment checks, and unsupported parser/dynamic-call expansion remain separate verification boundaries. No new language/call-graph parser, symbol index, OS support, proxy transport, or automatic Jira optional-scope retrieval is claimed here.
