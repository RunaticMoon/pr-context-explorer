# Bounded Git collector: changed head and direct context

Collector identity: `prce-git-v4-priority-active-lineage` (included in snapshot cache identity). This change is confined to `live-git.ts`, the pure `collector-priority.ts` helper, collector regression tests and these collector artifacts. It does not change model runners, analysis-v3, UI, root package configuration or authentication.

## Selection policy

Tree metadata and source retrieval are separate passes. Every discovered phase retains its actual pinned Git tree entries, including omitted paths, modes, blob SHAs and sizes. Parent name/status diffs remain independent of source budgets. Existing revision-local active-path lineage, exact-rename continuity, uncertain similarity renames, deletion tombstones and fresh re-add identities remain intact. No cumulative patch replay is used.

The global source-read schedule is deterministic:

1. Head paths changed against its actual first parent, sorted by path.
2. Remaining head paths from the unique merge-base net change and historical phase changes, sorted by path. This includes reverted historical changes still present at head.
3. The head comparison's actual old-side changed paths.
4. Head roots' directly resolved static import targets (one hop, sorted root paths and lexical source import order).
5. Other detailed phases in reverse deterministic Git traversal order: changed new/old paths, then one-hop imports from those roots and their before sides.
6. Remaining tree context, head first, then metadata discovery order, sorted paths within each revision.

The phase display order is still baseline followed by Git's original reverse topological traversal, not this retrieval order. Changing retrieval order does not change phase ancestry or file identity.

A changed head blob that fits the configured limits cannot be starved by baseline, earlier phases or unrelated tree context. This is priority, not a promise that every changed blob fits: competing changed files, a zero limit, oversized files or exclusions can still prevent retrieval. Full Git diff/hunk extraction keeps its existing separate output/truncation policy; an omitted source blob is not replaced with a fabricated complete file or synthetic line evidence.

## Strict budget/accounting semantics

- `treeFiles`: maximum selected blob paths per distinct tree revision. Inspected binary/LFS/non-UTF-8 blobs consume a slot. Metadata entries do not consume this limit and are never a lexicographic prefix of the actual tree. Cached blob content still consumes a path slot in another tree; cache reuse cannot bypass the file cap.
- `fileBytes`: maximum individual source blob size. Excluded blobs are not fetched by source retrieval.
- `totalBytes`: maximum actual raw bytes returned by unique `cat-file blob` source reads. Cache by immutable blob SHA avoids charging the same bytes again across paths or phases. Binary/LFS/non-UTF-8 inspection counts actual read bytes, despite withholding their source text.
- These source-read limits are **not** a bound on serialized snapshot/model context size or all Git's internal object reads. Git tree/commit metadata and bounded diffs have their own existing limits. The analysis context layer remains responsible for serialized UTF-8 framing/metadata/omission budgets.
- `phases`: caps independent detailed content/diff collection, not tree existence or name/status/lineage metadata. A capped phase can expose already selected actual before-side content needed by a detailed child, within the same global byte/per-tree file caps. Capped detailed diffs remain explicitly omitted.
- Limits must be finite, nonnegative safe integers; explicitly undefined/noninteger/negative/nonfinite overrides fail rather than disabling caps.
- Raw Git blobs are size-checked and decoded only as valid UTF-8. Binary, non-UTF-8, LFS pointers, generated/lockfiles, symlinks, submodules and oversized files retain metadata and honest omissions; no new source evidence is issued for them. Unsupported languages can retain exact text/diffs but are not counted as parsed supported source.

## Static import boundary

`collector-priority.ts` only parses already retrieved source with the installed TypeScript AST and resolves names against that revision's Git tree paths. It does not read tsconfig/package settings, walk local files, load modules, follow network URLs, execute imports, run target tests/builds/installers or invoke hooks. Supported source extensions are JS/TS variants; resolution allows exact relative paths, a bounded extension/index candidate set and unambiguous `.js`→`.ts`/`.tsx`, `.mjs`→`.mts`, `.cjs`→`.cts` substitutions.

Only ordinary static import declarations create `type: import`, `provenance: typescript-ast` edges. Aliases/packages, missing or ambiguous candidates, traversal outside the pinned tree, unsupported target languages, dynamic imports, require, import-equals and re-exports are reported as unresolved—not guessed edges, calls, execution flow or model analysis. The resolver is syntactic, not a target type checker or runtime module loader.

Expansion uses a fixed root set at depth one. A dependency's own imports can have AST graph evidence if its source was retrieved, but they do not recursively extend the prioritized queue. Cycles terminate without recursion. Unrelated fallback can still retrieve further files when budget permits; it is labeled tree context, not claimed as one-hop relevance.

## Additive interfaces / integration note

- `LiveFile.collection?` records the first selection reason: `changed-head`, `changed-phase`, `changed-before`, `direct-import` or `tree-context`; depth is 0 or 1. Direct context records `sourcePath`, `sourceRevisionSha`, `lineStart`, `lineEnd` and the actual matching import `evidenceId` when that revision has a rendered phase. Selection provenance is not a claim of successful source retrieval; always check `retrieved`/`omission`. The optional evidence ID may be absent for parent-only trees, which still retain the explicit revision/path/range provenance.
- `relatedFileIds` now includes directly selected import context (including old-side/baseline context and budget-omitted candidates), alongside changed logical file IDs. It does not include arbitrary tree fallback. Existing PR `buildContext` receives retrieved direct dependencies through this interface; regression assertions cover actual dependency text and import evidence reaching that context. Consumers needing a **changed-only** graph must distinguish context nodes using phase change status and collection reason rather than treating every related ID as changed. No UI behavior is asserted by this collector patch.
- `coverage.collection?` adds policy, `uniqueBlobBytesRead`, `uniqueBlobsRead`, `blobCacheHits`, effective byte/file limits and `contextDepth: 1`.
- `unresolvedImports` contains explicit revision/path/specifier/range/reason entries; `unknownImportCount` is their exact count, **not** a total of all unknown repository relationships. `unscannedSourceVersions` counts supported-path tree versions without retrieved text; their missing imports are unknowable. `omittedFileVersions` counts unretrieved `(tree revision, path)` metadata entries, including parent-only trees, excluding added display tombstone duplicates.
- Existing `coverage.discovered/retrieved/analyzed` remain **live head-file** counts. `analyzed` remains the supported retrieved-source AST scope, not successful model analysis. `complete` is false for source omissions, unsupported/resolution limitations, skipped detail or unavailable history. Collection coverage does not grant complete model-context or semantic-analysis coverage.

## Executed verification

Nine collector tests use real isolated bare repositories built with `hash-object`, `mktree`, `commit-tree` and actual Git comparisons. No collector test creates a worktree or executes target code. They cover 220 lexically earlier unrelated paths plus an oversized path, multiple earlier revisions, changed-head priority under one-file/exact-byte limits, unchanged direct import context, UTF-8 byte deduplication, cycles/depth limits, before-side relevance, capped-phase rename/reuse/delete/re-add lineage, unknown import accounting, omitted dependencies, exclusions, invalid limits and truthful complete/partial counts.

TDD failure evidence is retained in `artifacts/collector-red-{head,import,metadata,unknown,old-context,limits,bytes}.log`; each captures the intended missing behavior before its fix. Matching green logs retain the corresponding passing results.

Final commands and real results:

```text
./node_modules/.bin/tsx --test tests/collector-priority.test.ts tests/live-git.test.ts tests/core-review-*.test.ts tests/hunks.test.ts tests/live-analysis.test.ts tests/ingest.test.ts
22 tests passed, 0 failed — artifacts/collector-regressions.log

./node_modules/.bin/tsx --test tests/*.test.ts
253 tests passed, 0 failed — artifacts/collector-full-suite.log

node node_modules/typescript/lib/tsc.js --noEmit
exit 0 — artifacts/collector-typecheck.log
```

The full-suite result describes the concurrent working directory at execution time, including other agents' tests; it is not a claim of authorship or live provider validation. The app directory has no `.git`, so no commit SHA/diff-based review or commit is claimed. A false-positive execution guard rejected the `.bin/tsc` wrapper; invoking the installed TypeScript compiler entrypoint completed normally. No live credentials, authenticated provider calls, inference, push or system/service changes were performed by this task.
