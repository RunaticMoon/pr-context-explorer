# Desktop CI root causes

Evidence: actual Mac run `34932821826`, job log
`artifacts/github-job-104264434466.log`, especially lines 2029–2073 and 2610–2623.
Local verification below was performed on Linux arm64 on 2026-09-15. It is not a
positive Mac GUI or signed/unsigned package acceptance result.

## First window: prepared sidecar deleted by the intervening rebuild

The actual smoke log reaches `app-app-ready`, immediately reports
`app-startup-error-dialog`, and never reaches `app-backend-start`. The supervisor
observed an owned Electron process but no backend. Thus renderer navigation,
webRequest restrictions, permission handlers and the asynchronous backend
readiness wait are downstream of this failure, not supported immediate causes.

The workflow sequence is `desktop:prepare` → `npm test` → `test:desktop` →
`desktop:smoke`. Prepare installs verified host Node at
`desktop/build/node/bin/node`. `test:desktop` calls `desktop:build`, whose
`desktop/build.mjs` previously deleted the entire `desktop/build` directory.
Nothing in that script restored host Node. In `main.ts`, the missing-sidecar
check throws before updater/menu initialization and before `backend-start`.
The generic startup dialog hid this resource error behind advice about Git.

The isolated executable rebuild regression reproduced ENOENT for the prepared
Node executable before the fix. Compilation now removes its generated outputs
but preserves the separately provisioned `node` directory. Stale runtime files
are still removed. Node download checksums, app sandbox and all runtime security
checks remain unchanged.

Local verification additionally provisioned the real pinned Node 24.21.0 host
sidecar, ran the actual `test:desktop` rebuild, executed that same surviving
sidecar, then ran the compiled backend/UI/demo/dynamic-module integration test
with `PRCE_TEST_NODE` explicitly pointing to it. All passed. The actual Mac error
text was not captured, so a new Mac run must confirm that this reproduced defect
was the only startup blocker.

## Build-only packaging: repeated `never` becomes a publishing array

Log line 2073 shows the exact executable arguments:
`electron-builder ... --publish never --publish never ...`.
The first flag comes from package.json; npm correctly appends the workflow's
second flag to the final command. No argument was lost to a programmatic wrapper
or appended to the wrong compound command.

The installed electron-builder 26.16.1 parser returns
`publish: ["never", "never"]`. `normalizeOptions` preserves the array.
`PublishManager` compares policy to the scalar string `"never"`; the array
passes that inequality and enables publishing. The subsequent artifact event
constructs `GitHubPublisher`, causing the observed missing-GH_TOKEN error.
Adding a publisher token would authorize the unintended action, not fix it.

`desktop/package-mac.mjs` now validates the caller's policy with the pinned
builder parser, rejects publication requests, canonicalizes redundant `never`
flags (including aliases), and verifies that the actual forwarded parser result
is the scalar `"never"` before spawning electron-builder without a shell. Both
Mac packaging scripts use this build-only wrapper. Existing config/target
arguments are forwarded; publish metadata remains available for signed builds.

The regression executes the real npm compound scripts in a disposable cwd,
substituting only expensive build/download commands and the final packaging
executable with argv-capture shims. The wrapper itself executes normally. Captured
argv is fed through the actual builder parser, `normalizeOptions`, `Packager`
and `PublishManager`. A real artifact event with the configured GitHub provider
must leave the publisher map empty. No publisher credentials or upload are used.

## Failure reporting: do not wait for retained Playwright handles

The worker reported `failed-first-window` at 12 seconds but the supervisor waited
for worker exit until its 70-second deadline. The worker's 55-second budget only
bounds its awaited steps; it does not force termination of retained inspector
sockets after the bounded failure-close attempt.

The supervisor now waits through `driverResult`, which rejects immediately on a
validated `failed-*` stage message. Existing failure-only identity-verified
process-group cleanup then runs. The separate exit promise is still used to reap
the driver. The 70-second outer bound remains for genuine silence/hangs. Success
still requires all worker assertions, the success message and a zero process
exit. No dialogs are dismissed, permissions granted, or sandbox flags weakened.
A real IPC worker emitting `failed-first-window` while retaining live handles
provides the local regression; it is a fixture, not a simulated Mac pass.

## Local results and outstanding acceptance

- RED→GREEN: prepared-sidecar rebuild regression; duplicate-policy executable
  regression; failure-message-aware supervisor regression.
- `npm test`: 337 tests, 331 passed, 6 skipped, 0 failed.
  Log: `artifacts/desktop-fix-unit.log`.
- `node desktop/node-runtime.mjs --host && npm run test:desktop`: passed.
  Log: `artifacts/desktop-fix-runtime.log`.
- Compiled integration test repeated with actual bundled Node 24.21.0: passed.
- `tsc --noEmit` and `git diff --check`: passed.
- Outstanding: parent's real Mac Electron first-window/normal-quit and packaged
  launch rerun, plus independent review. No workflow edits, commits, pushes,
  credentials, quarantine bypasses, `--no-sandbox`, or security relaxations were
  made for these fixes.
