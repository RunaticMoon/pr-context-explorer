# Electron Mac smoke timeout: bounded failure, mandatory normal quit

## Evidence and limits

ActualMacCI run `34929982015`, job `104256009589`, artifact
`artifacts/github-job-104256009589.log` establishes:

- Lines 2010–2019: compiled desktop runtime and backend smoke passed on the real Mac.
- Lines 2021–2024: Electron smoke started at `04:45:26` and hit the 60-second node:test timeout at `04:46:26`.
- Lines 2025 and 2052–2056: cancellation at `05:12:13`, followed by runner cleanup of Electron and its helpers. There is **no last-stage or native-error evidence** in the original log.

The old test awaited both `app.evaluate(app.quit)` and an unconditional, unbounded `app.close()` in `finally`. A node:test timeout does not cancel those Playwright promises or their inspector sockets. Playwright's launcher also waits on protocol setup and performs its own teardown before its launch promise settles. The existing log cannot distinguish launch, first-window, a native startup/active-work dialog, or quit as the original blocking stage. This change fixes the demonstrable unbounded harness and adds evidence; it does **not** claim the underlying Mac GUI startup is repaired.

## Harness changes

- A separate, test-created Node driver owns Playwright. Operations share a 55-second work budget and individual stage deadlines. Failure-only `app.close()` has a 3-second deadline.
- The supervisor permits 70 seconds for the entire driver, including its teardown. It then performs bounded identity observation/reaping/temp removal. node:test's 90-second timeout is a last guard, not the cancellation mechanism. The workflow timeout remains independent.
- Normal success requires every original sandbox/context-isolation/read-only preload/capability assertion, version `0.4.0`, external updater, actual Electron close event, **normal process exit `(0, null)`**, removal of the exact runtime marker, and backend PID absence (`ESRCH`). Marker absence must be `ENOENT`, not an arbitrary read error.
- Normal quit is scheduled after evaluate can return. No confirmation or OS dialog is dismissed. Forced cleanup is never a successful quit or a passing test.
- Only failure invokes supervisor force cleanup. Electron PID comes from this driver's Playwright launch log/handle, then `/bin/ps -p <exact-pid>` verifies parent, executable, app path, unique temp-data argument, UID and group leadership. The backend PID must come from that unique temp directory's marker and match the observed Electron parent plus the exact bundled Node/backend command. Before signaling a group, its PID/start time/command/UID/group are checked again. The driver itself is reaped through its original ChildProcess handle. No broad process scan or machine-wide kill is used; identity mismatch refuses signaling rather than guessing.
- The backend marker now includes its PID immediately after spawn, before readiness, so startup failures are also observable.

## Safe diagnostics

The supervisor drains its own driver's output without forwarding raw contents. `DEBUG=pw:browser` is set **only in that child**; it is not global and protocol payload debugging is not enabled. Output is reduced to fixed, deduplicated categories: Node inspector listening, Chromium DevTools listening, debugger-disconnect wait, sandbox/display/OS-permission failure, and explicit app milestones. No environment, launch command, inspector URL, token, HTTP body, page contents or model/source output is printed or persisted.

The nonpackaged app's existing test-data override enables fixed stage labels only: app ready, backend start/ready, window load/shown, startup-error dialog, backend-stopped dialog, active-work confirmation, and normal-quit backend stop/stopped. Packaged apps do not emit them. Failure prints the last driver stage plus the observed category set and ownership/cleanup booleans.

Interpretation for the next real Mac run:

- `launch` without inspector/DevTools categories: inspect OS/session/native startup prerequisites; do not disable the sandbox or Gatekeeper.
- `app-startup-error-dialog` or `app-backend-stopped-dialog`: real product startup failure, not a dialog to auto-dismiss for a pass.
- `first-window` with `app-backend-start` but no ready: backend readiness issue.
- `app-active-work-confirmation` at normal quit: unexpected active/unavailable work state; the test must fail rather than select cancellation.
- `normal-quit-close-event` with backend stopped: investigate Electron/inspector termination.

## Verification in this Linux workspace

- `npm run test:desktop`: **18 desktop unit tests passed**, TypeScript and compiled desktop build passed, and the actual compiled runtime/backend smoke passed.
- New regressions cover a never-settling `app.close`, late rejection after a stage deadline, identity mismatch refusal and termination of a real test-owned process group, and safe stderr classification.
- `node desktop/node-runtime.mjs --host && npm run desktop:smoke`: failed closed in under one second, with `launch` / `sandbox-unavailable` and an identified owned Electron process. The host lacks the required usable SUID sandbox. No sandbox bypass was attempted. This verifies the real launch-failure reporting/exit path, **not** a successful GUI launch.

Required next Mac commands: `npm run test:desktop`, `node desktop/node-runtime.mjs --host`, then `npm run desktop:smoke` under the workflow's bounded desktop step. A successful real Mac launch/quit remains mandatory before claiming the GUI regression resolved. No signing, sandbox, renderer IPC or secret-capability policy was relaxed.
