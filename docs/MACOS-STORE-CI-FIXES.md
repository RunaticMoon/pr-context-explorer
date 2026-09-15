# macOS store fixture portability fixes

## Scope and cause

Evidence: `artifacts/github-job-104249916708.log`, actual Apple Silicon Actions run `34927954142` at revision `906ffaa`.

The non-AI failures at log lines 1230–1333 occur while opening app-created temporary fixtures, before the substantive API/cache assertions run. `privateDirectory()` rejects symlinks in **every** path component. On macOS, system temporary paths can contain legitimate aliases (`/tmp` → `/private/tmp`, `/var` → `/private/var`). Passing the raw `mkdtemp()` result into the store or settings reader therefore fails intentionally strict validation. The settings failure is the same fixture-path issue, not a mode/UID failure.

A Linux reproduction set `TMPDIR` to a real directory symlink and ran the existing store/settings/desktop tests. Before the fix, 3 of 4 tests failed with the same `unsafe store directory` / `server settings symlink denied` errors. Evidence: `artifacts/macos-store-alias-red.log`.

## Changes: fixtures only, no production source changes

Canonicalize only the newly created, test-owned scratch root immediately after `mkdtempSync`/`mkdtemp`, before creating subordinate store/settings/security fixtures. Cleanup uses the same canonical root.

Modified:

- `tests/store.test.ts`: store scratch root (the separate passing Git-retention setup is unchanged).
- `tests/settings.test.ts`: private settings scratch root.
- `tests/desktop-runtime.test.ts`: ephemeral backend data root.
- `tests/live-api.test.ts`: API/store/static-asset scratch root.
- `tests/integration-core.test.ts`: core API data root.
- `tests/integration-v3.test.ts`: V3 API data root.
- `tests/integration-v3-boundaries.test.ts`: shared V3 boundary API data root.
- `tests/e2e/desktop-runtime.mjs`: copied, checkout-independent compiled runtime/data root.
- `tests/e2e/desktop-electron.mjs`: nonpackaged Electron test user-data override.
- `tests/e2e/v3-integration.spec.ts`: both browser/API store roots.

Added `tests/tmpdir-portability.test.ts`: a portable POSIX regression runs the actual store, settings and desktop tests beneath an aliased `TMPDIR`. It was observed failing before the fixture fix and passing after it. The nested Node runner removes `NODE_TEST_CONTEXT` from its child environment; otherwise Node may exit successfully without executing the child tests.

No changes to `src/server/store.ts`, `src/server/settings.ts`, desktop production source, API contracts, type-check scope, or existing assertions. Malicious store-file links, store-parent links, settings-file links and static-asset escapes are still passed **unresolved** to production validation and rejected. Modes remain 0700/0600; stale, retention, selective cache reuse, provenance reload, consent and cancellation assertions remain intact. No tests were disabled.

## Production desktop path review

`desktop/main.ts` derives the production user-data directory from Electron `app.getPath("appData")` plus `PR Context Explorer`; `desktop/security.ts` derives its `live` store path from that directory. The normal macOS layout is `~/Library/Application Support/PR Context Explorer`, not the temporary fixture directory. No production caller was changed to resolve arbitrary user-supplied paths, and intentional symlinked user-data/store paths still fail closed. `PRCE_DESKTOP_TEST_DATA` is restricted to nonpackaged launches; its test-owned creator is fixed here.

This source review does not prove the filesystem layout or packaged app launch on a Mac. The actual sealed-app launch test remains the check of the runner's real `~/Library/Application Support` path; it must run on the Mac rerun. Nonstandard symlinked home/app-data layouts are not silently accepted by this change.

## Verification performed locally (Linux)

- `tsx --test tests/tmpdir-portability.test.ts tests/store.test.ts tests/settings.test.ts tests/desktop-runtime.test.ts tests/integration-core.test.ts tests/integration-v3.test.ts tests/integration-v3-boundaries.test.ts tests/live-api.test.ts`: **12 passed, 0 failed, 0 skipped**.
- The seven affected existing unit/integration files above, rerun with `TMPDIR` pointing through a real symlink: **11 passed, 0 failed, 0 skipped**. Evidence: `artifacts/macos-store-alias-green.log`.
- All top-level `tests/*.test.ts` except the separately owned `tests/ai-*.test.ts` (46 files): **184 passed, 0 failed, 0 skipped**. Evidence: `artifacts/macos-store-linux-core.log`.
- `node_modules/.bin/tsc --noEmit`: passed, including the final retry after concurrent AI edits settled.
- `npm run desktop:build && node --test tests/e2e/desktop-runtime.mjs`: passed; freshly compiled/copied runtime smoke **1 passed**. Vite emitted its existing ignored `use client` dependency warning.
- `node_modules/.bin/playwright test tests/e2e/v3-integration.spec.ts --workers=1`: **2 passed**, covering real HTTP/Chromium cache/reload/back and exact second-parent navigation with explicitly fake model responses.
- `git diff --check`: passed.

Two earlier desktop-build attempts caught an in-progress syntax error in separately owned `src/server/ai/probes.ts:101`. This fixer did not edit that file; a later complete build and runtime smoke passed after the other work changed it.

## Pending / ownership boundary

Actual macOS validation and real Electron GUI launch remain pending the parent agent's Mac rerun. Linux symlink reproduction is not Mac runtime evidence. The original AI auth/launcher/runner/Seatbelt/TLS/native-engine failures are owned by the separate AI fixer and are not claimed fixed here. No edits to `src/server/ai/**`, `tests/ai*.test.ts`, workflow files, commits, pushes, remote actions or credentials were performed by this fixer.
