# V3 independent-review fixes

## Outcome and scope

All five reported defects are fixed in the isolated V3 module, with permanent regressions in `tests/analysis-v3-review-fixes.test.ts`. No API/UI/root dependency files or existing tests were edited. `index.ts`, `types.ts`, and `output-schema.ts` match the independent review's SHA-256 manifest exactly; exported signatures and result/error shapes remain unchanged.

The independent repro was run **before production edits**: all five intended safety assertions failed. Each defect then received permanent RED tests before its production fix. Final verification: **41/41 V3 suite entries**, **5/5 corrected independent repros**, scoped TypeScript, and formatting checks pass. The five deadline tests additionally passed three repeated runs. The suite includes the existing fixture-only test-file entry; these counts are Node's actual reported counts, not model evaluations.

## Fixes and integration semantics

### R1 — fail closed after applying a valid audit

`run.ts` separates audit acquisition/schema validation from applying a validated audit and validating its transformed candidate.

- An acquisition/schema failure retains the existing optional policy: `semanticAudit.status: failed`, `failureCode: semantic_audit_failed`, partial output under the default policy; `failurePolicy: fail` throws `semantic_audit_failed`.
- An explicit audit rejection still throws `semantic_audit_rejected`.
- Invalid transformed output now **always throws `final_validation_failed`**, even under the default downgrade policy. Its error carries the valid audit output, original-candidate hash, and dispositions, with audit status `failed` and failure code `final_validation_failed`.
- The original disputed candidate is never returned as normal output. Historical-step structure is not silently repaired or restored. A downgraded historical reason violates the historical exception's evidence requirement, so this case rejects instead of returning the disputed observed claim.

The permanent regression reproduces the exact historical-reason downgrade with actual Git history and tests both failure policies. Existing valid downgrade, explicit rejection, incomplete audit, and schema-overflow regressions remain green.

### R2 — actual live head primary, old evidence only as comparison

`validate.ts` requires `focusEvidenceIds[0]` of every nonhistorical step to be **new-side evidence whose actual `revisionSha` is head**. Existing context validation independently proves that the file is retrieved and not deleted at that revision; a head-owned comparison's `commitSha` alone is not sufficient.

Old-side focus evidence remains legal **after the primary** as a secondary comparison, and each such ID must occur in `beforeAfter.evidenceIds`. A real deletion of `legacy.ts` plus addition of `replacement.ts` now:

- rejects an old-only or old-first default step;
- retains a valid live-primary step with the deleted file's original parent-side evidence explicitly cited in `beforeAfter`;
- produces an empty tour plus `tour_failed` omission and partial analysis if the runner supplies the invalid tour.

Historical opt-in, distinct target revision, grounded historical reason, comparison scoping, and return-to-head constraints remain intact. `prompt.ts` explicitly explains the primary/secondary rule and advances the internal prompt version to `v3-grounded-stages-2`; cache keys already include prompt/version hashes. Consumers should navigate the first focus evidence as the primary rather than treating every comparison reference as live code.

### R4 — one execution-claim guard, including audits

The existing narrow test/CI-success guard moved from `validateStage` into the shared `validateGroundedStatement` implementation in `schema.ts`. Audit `scopeSummary`, issue reasons, and unable-to-verify reasons now receive the same schema, kind, reference, and execution-claim checks as normal output.

The exact observed/inferred claim `All tests passed. CI is green.` is rejected in every audit statement location. Invalid audit payloads are not retained as performed audit output; default-policy acquisition failure is explicit and partial. Unknown statements still require their existing limitation. The phrase guard is intentionally limited and is **not** universal semantic verification. Target-test and external-CI flags remain false.

### R5 — bind the complete derived evidence record

`evidence.ts` reconstructs the canonical range record from an actual containing snapshot evidence record and compares every supplied field and the field set, including the exact canonical ID, both comparison/revision SHAs, path, blob, whole-source hash, side, and range. IDs are not trimmed, case-folded, or repaired. Property insertion order is not treated as immutable evidence content.

Actual captured Git content, range text, and content hashes are still independently checked; supplying plausible hash text is insufficient. The real two-parent merge regression proves that both independently generated parent-derived records remain valid and distinct, while replacing the left range's fields and excerpt with the real right-parent blob under the left range ID rejects in both `validateCodeEvidence` and `validateContextBundle`. Noncanonical ID spelling and extra supplied fields also reject.

### R3 — per-call monotonic deadlines

`run.ts`'s bounded callback helper now captures an individual monotonic deadline in addition to the timer and total pipeline deadline. It checks expiry on both callback resolution and rejection, aborts the supplied signal when expired, and rejects late values before validation or cache reuse. Cancellation and total-deadline errors retain precedence over callback errors and individual timeouts.

The same helper protects cache get/set callbacks. Expired cache callbacks remain `cache_unavailable`, not timely cache hits or an engine fallback. Existing stage-specific behavior remains intact: failed chunks are omitted, synthesis failure rejects, and optional tour/audit failure is explicit and partial where the existing policy permits. Tests cover the exact 5 ms budget / 30 ms synchronous callback, synchronous rejection, normal callbacks, cache callbacks, later stages, cancellation, and total expiry.

JavaScript cannot interrupt synchronous work mid-execution: the fix rejects late results as soon as control returns. It does not claim to kill hidden custom-runner processes or change the existing production AI adapter's separate total deadline.

## Independent harness correction, not weakened validation

`artifacts/review-v3/repro.test.ts` is unchanged. After the fixes it reports 3 passes and 2 harness errors:

- R4 dereferences `semanticAudit.output.scopeSummary`, although correctly rejected acquisition no longer returns that invalid output.
- R5 invokes the now-rejecting `validateCodeEvidence` outside its expected-exception assertion.

`artifacts/v3-fix-independent-repro.test.ts` preserves the original fixture/runner logic and safety assertions, changes relative imports for its copied location, captures R4's attempted claim directly for its normal-output positive control, and asserts R5's earlier rejection explicitly. It passes 5/5. The original after-run log is retained, rather than claiming that the unchanged harness passes.

## Verification and artifacts

Reproduce all final scoped checks and the hash-verified API comparison:

```sh
python3 artifacts/v3-fix-verify.py
```

Evidence:

- `artifacts/v3-fix-independent-red.log`: original independent repro, 0 pass / 5 fail before fixes.
- `artifacts/v3-fix-r{1,2,3,4,5}-red.log`: permanent RED runs. R3 has one passing within-budget control and four failing regressions.
- `artifacts/v3-fix-r{1,2,3,4,5}-green.log`: incremental GREEN runs with relevant existing suites.
- `artifacts/v3-fix-suite-green.log`: 41 pass / 0 fail.
- `artifacts/v3-fix-independent-original-after.log`: unchanged harness, 3 passes / the 2 earlier-rejection harness errors described above.
- `artifacts/v3-fix-independent-green.log`: corrected independent copy, 5 pass / 0 fail.
- `artifacts/v3-fix-typecheck.log`, `artifacts/v3-fix-format-check.log`: successful scoped checks.
- `artifacts/v3-fix-deadline-repeat-{1,2,3}.log`: each 5 pass / 0 fail.
- `artifacts/v3-fix-verification.json`: commands, exit codes, parsed counts, source hashes, and verification boundaries.

Production changes are limited to `evidence.ts`, `prompt.ts`, `run.ts`, `schema.ts`, and `validate.ts` under `src/server/analysis-v3/`. New permanent tests, this document, and `artifacts/v3-fix-*` are the only other task writes.

## Boundaries and reusable review lessons

These tests use real immutable Git objects and explicitly scripted analysis/audit callbacks, not model inference or semantic-quality evaluation. Target source, real credentials, external CI, and live providers were not executed/accessed. Full app/API/UI integration verification belongs to the concurrent integration owner. No commit was made: this supplied project directory has no Git worktree metadata.

For future reviews: separate acquisition failure from invalid trusted transformations; validate a tour's actual navigation side rather than its comparison owner; bind a derived ID to the complete canonical record and actual bytes; share statement guards with separate audit payloads; test monotonic expiry on both success and error paths. Keep independent reproductions immutable and correct only documented harness assumptions in a separate copy when earlier fail-closed rejection makes a diagnostic probe obsolete.
