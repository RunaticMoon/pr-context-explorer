# Independently reproduced core fixes

Verified 2026-09-14 in `/home/ubuntu/development/pr-context-explorer`.

## Scope and ownership

Production changes are limited to `src/main.tsx`, `src/live.tsx`, `src/server/live-git.ts`, and `src/server/live-analysis.ts`. No edits to `src/server/ai/**`, `src/server/jira/**`, their tests, root CSS, the Korean font regression, or the separately developing `analysis-v3` implementation. No accounts, credentials, target-project execution, real model inference, or public deployment were used.

This directory is not an application Git working tree (`git status` reports no repository). Git validation below uses actual isolated bare repositories and real Git object/parent/diff commands, not fabricated command responses.

## Defects, RED evidence, and changes

| Defect | Independently rerun RED | Remedy and GREEN verification |
|---|---|---|
| Direct live entry created two sessions and sent a stale CSRF token | Original `session-repro.ts`: three fresh browser contexts each produced two bootstraps and HTTP 403. Permanent browser test also failed with the exact CSRF error. | Root owns the sole session bootstrap and passes its CSRF token to LiveApp. Real HTTP browser tests save public connection settings, read back the saved record, reload, navigate through demo, use browser Back, and save again. Original harness now asserts one bootstrap and HTTP 201 in each fresh context. |
| Rename `a.ts → b.ts`, then re-add `a.ts`, conflated identities and evidence | Original `repro.ts` plus permanent linear/nonlinear Git regressions failed on duplicate file IDs and invalid evidence. | Revision-local active-path maps replace accumulated retired paths. Fresh identities include their birth revision; exact renames inherit from the actual first parent, never another traversed branch. Similarity-only renames remain unmerged. Tombstones keep the departed identity but do not enter the next active-path map. Phase-file and evidence uniqueness are asserted before collection returns. Canonical shared-range evidence avoids duplicate IDs for multiple imports on one line. |
| Truncated context could still be accepted as complete; budgets used JS character length | Original harness accepted `complete` despite missing head-side code. UTF-8/escaping regression measured 1,771,844 serialized context bytes under the old policy. | The 800,000-byte code/evidence sub-envelope and 1,000,000-byte entire context envelope use actual serialized UTF-8, including framing, escaping, metadata, omission records, and the byte counter itself. Oversize metadata fails explicitly. Validation rejects complete output whenever model context is omitted, and rejects references outside an explicitly supplied context. Results return `contextCoverage` for the existing persistence path, including actual transmitted/missing evidence/source/edge IDs, measured bytes, original collection completeness, and context completeness. Live UI displays these omissions separately from collection coverage, plus model-provided missing context. |
| Q&A from Guided Flow replaced the PR/tour result while retaining the selected step | Original UI harness reached the invalid-selection workspace. Permanent cached and asynchronous completion tests both failed. | PR result/cache key (`analysis`) remains separate from scoped code result/key (`codeAnalysis`). Both completion paths atomically select Code Explorer and clear active tour/step state. Last tour step is retained separately for resumption. Scoped answers are displayed only for the matching revision/file/side/range. Reload and Back restore both cached results without rerunning analysis. |
| Collected AST import edges disappeared from model context without omissions | Original Git harness collected one edge and transmitted zero. Multiline-import regression failed on missing edge IDs. | PR context retains actual AST edge IDs and bounded evidence snippets when their source is covered. Multiline imports include their actual ending line. Full-file references require both matching range endpoints, so a line-one import is not misrepresented as whole-file evidence. Deliberate scope/budget edge exclusions are recorded. Code Q&A remains a single selected range and explicitly records excluded edges. |

The collector version and prompt version changed so new collection/analysis keys do not reuse the defective versions. Existing immutable snapshots and previously saved analysis links are not rewritten: re-collect/re-run to obtain repaired identities and new context-coverage metadata. This patch does not reprioritize the old context ordering or claim that omitted head code was analyzed.

## Permanent regression tests

- `tests/core-review-helpers.ts`: isolated bare Git object fixture builder.
- `tests/core-review-git.test.ts`: rename/reuse/delete/re-add and branching/merge lineage.
- `tests/core-review-context.test.ts`: completeness rejection, explicit included/missing IDs, serialized multibyte/escaping budgets and measured byte count.
- `tests/core-review-edges.test.ts`: multiline AST ranges, real edge IDs, shared-range canonical evidence and explicit scoped exclusions.
- `tests/e2e/core-review-session.spec.ts`: actual server/browser cookie jar, no API interception, saves plus exact record readback, reload/Back/demo navigation.
- `tests/e2e/core-review-qa.spec.ts`: actual built UI and real Git snapshot; explicitly intercepted schema-validated provider results, separately testing cached and asynchronous completion, scope rendering, context omissions, reload/Back and tour resumption. This is not inference or a live-provider smoke test.

## Reproduction scripts remain rerunnable

The original review scripts were first run unchanged. Their actual RED output is retained in:

- `artifacts/review-core/core-red-repro.log`
- `artifacts/review-core/core-red-session.log`
- `artifacts/review-core/core-red-ui.log`

`--expect-fixed` adds positive assertions while keeping the original bug-assertion mode. Fixed runs write separate `*-fixed-results.json` reports. Run the Git script before the UI script, because the UI harness reads its produced immutable Git snapshot:

```sh
npm run build
./node_modules/.bin/tsx artifacts/review-core/repro.ts --expect-fixed
./node_modules/.bin/tsx artifacts/review-core/ui-repro.ts --expect-fixed
./node_modules/.bin/tsx artifacts/review-core/session-repro.ts --expect-fixed
```

All three fixed script runs exited 0. The exact output is in `core-green-{repro,ui,session}.log` and `repro-fixed-results.json`, `ui-fixed-results.json`, `session-fixed-results.json` in the same artifact directory.

Permanent RED records: `session-test-red.log`, `git-test-red.log`, `context-test-red.log`, `context-completeness-red.log`, `edges-test-red.log`, `edges-shared-range-red.log`, `qa-test-red.log`. The session test's expected successful save status was corrected from 200 to the existing API's documented-in-code 201; the initial observed failure was 403, and response plus record readback are still asserted.

## Verification and concurrent-work boundary

Commands actually executed:

```sh
npm exec -- tsc --noEmit --project artifacts/review-core/tsconfig.core.json
./node_modules/.bin/tsx --test tests/core-review-*.test.ts tests/live-analysis.test.ts tests/live-git.test.ts tests/integration-core.test.ts
./node_modules/.bin/playwright test --reporter=list
npm test
npm run build
```

- Scoped TypeScript check: exit 0. The artifact config extends the project config and includes **all production source** plus the new core regression tests; it does not change or weaken the project config.
- Core and adjacent regression suite: **12 passed, 0 failed**, `core-tests-green.log`.
- Entire existing browser suite plus new regressions: **10 passed**, including demo, malicious selection boundaries, Korean self-hosted fonts, live workspace, both Q&A completion paths and real session saves. `core-all-e2e.log`.
- Vite production bundling: exit 0, `core-vite-build.log`. Because concurrently added tests temporarily blocked the full TypeScript build, bundling was also exercised directly with Vite's `build()` API; this is not represented as full `npm run build` success.
- Last full `npm test` run: **225 passed / 228 tests**, with three failures in the parallel `tests/analysis-v3-run.test.ts` work (`runPipeline` not yet exported). Earlier transient adapter/contract failures changed as their owners worked; no independent files were altered to make the aggregate green.
- Last full `npm run build`: blocked by that same parallel V3 test's missing `runPipeline` export and dependent implicit-any diagnostics. `core-final-build.log`. Re-run the aggregate after that work is complete.

Browser evidence: `qa-cached-fixed.png`, `qa-async-fixed.png`, `code-from-tour-fixed.png`. The cached-answer screenshot was visually inspected: old/new source panes, selected answer and explicit import/context omissions are visible. Long-ID wrapping/header overlap are not claimed pixel-perfect; root styling remains with its owner. No browser page errors were observed by the Q&A regression harnesses.

The fixes are core-only; full-workspace green depends on the parallel V3 work completing. No target tests/CI or model semantics are asserted by these checks.
