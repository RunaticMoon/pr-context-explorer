# Hard update rollback — Mac gate timeout diagnosis

## Incident

Mac15 run `35116723866`, job `104863907987` (`artifacts/github-job-104863907987.log`):
`tests/e2e/public-update-mac.mjs` failed inside `runMacGate` with
`Timed out: durable helper transaction result` after the full 140 s receipt wait.
Whole test duration 219 s. Every prior phase — extraction, signature audit,
native ACL check, fixture signing, positive-case install/commit — had passed.

Timeline from the log:

- `15:41:19` gate starts; fixtures signed at `15:41:25`, `15:41:59`, `15:42:04`
- `~15:42:39` rollback case: old fixture quit observed, `result.json` wait begins
- `15:44:59` 140 s elapse; test fails. The log contains no worker exit code, no
  error code, and no receipt state — the old harness polled `result.json` only
  and discarded `workerOutput` at timeout.

## What was confirmed in source (not the proven Mac cause)

Tracing the path end to end found real defects that make this failure
unobservable, and one that can pin a failed new instance open:

1. **Silent worker failure.** `helper-entry.ts` caught every `runHelper` error
   and set `exitCode = 1` with no error propagation. Any `UpdateError` during
   plan validation, old-exit observation, app validation, launch, or rollback
   produced an exit-1 worker with zero signal. The harness then polled
   `result.json` for 140 s regardless.
2. **Masked rollback cause.** `transaction.ts` caught the rollback error and
   rethrew `ROLLBACK_FAILED`, discarding both the primary failure code and the
   cleanup stage that failed.
3. **Dialog-blocked termination.** `main.ts` `.whenReady().then(launch).catch`
   awaited a user-dismissable "Unable to Start" dialog before `app.quit()`. A
   plan-driven instance is an unobserved probe — nobody dismisses the dialog, so
   the failed process could outlive the helper's SIGTERM/10 s stop budget.
4. **Unraced, mis-composed harness wait.** The 140 s wait could not see a dead
   worker, and it was a fixed guess: legitimate helper work after old-exit is
   bounded by `validateApp` (deep codesign), the 90 s startup budget, the 10 s
   stop budget, restore/revalidate/relaunch — a worst case that can exceed 140 s
   without any production defect.

## What changed

- `desktop/public-update/policy.ts` — `errorCode()`: bounded code extraction.
  Update codes and `E*` errno codes survive; arbitrary message text never does.
- `desktop/public-update/helper.ts` — `updatePlanRequested()` (exact
  `--prce-update-plan=` argv detection), `helperFailureCode()`,
  `reportHelperFailure()` (exclusive `failure.json` beside the plan, and only
  inside a transaction-shaped `.prce-update-<64-hex>` workDir; never overwrites
  `result.json`; write failures never change the exit contract),
  `phaseMarker()` (single-write `phase.<step>` markers, fixed lowercase labels;
  malformed labels still fail, marker I/O is best-effort and can never abort an
  update, stop, restore or relaunch), `updateProbeActive()` (pure predicate
  bounding probe suppression to the pre-commit window), `sendHelperMessage()`
  (best-effort bounded IPC send; asynchronous channel errors go to the
  callback, never to stderr), `stopFailedBoot()` (boot-receipt + exact identity
  check + SIGTERM + 10 s bound →
  `STARTUP_UNCONFIRMED`/`PROCESS_IDENTITY`/`STARTUP_STOP_TIMEOUT`). `runHelper`
  marks `old-exited`, `launched`, `boot-observed`, `stopping-failed`,
  `failed-stopped` and forwards `mark` as the transaction checkpoint.
- `desktop/public-update/transaction.ts` — rollback stages tracked
  (`marking`/`stop-failed`/`parking-failed`/`restoring`/`revalidating`/
  `relaunching`/`recording`); on rollback failure a bounded `failure.json`
  records `code` + `rollbackCode` + `stage` before `ROLLBACK_FAILED` is thrown.
  Backup and lock are preserved. The durable `rolled-back` `result.json` is
  still written before the original rejection propagates.
- `desktop/public-update/helper-entry.ts` — failure is reported via
  `reportHelperFailure()` and, when the ready handshake already completed, a
  bounded `{type:"failed",code}` IPC message through `sendHelperMessage()`.
  Exit code contract unchanged.
- `desktop/main.ts` — `updateLaunch` is resolved at module scope from argv and
  `updateCommitted` flips once alongside `startupCommitted`. Dialog
  suppression is bound to `updateProbeActive(updateLaunch, updateCommitted)` —
  the pre-commit probe window only; a committed instance is an ordinary session
  and shows the existing dialogs again (the flag is irreversible because
  backend death resets `startupCommitted`). Packaged `registerStartup` /
  native-ACL binding is unconditional again; no signed-path behavior change.
- `tests/e2e/public-update-mac.mjs` — `awaitWorkerReceipt()` races the durable
  receipt poll against `workerDone`, bounded by `plan.deadline + 120 s` (the
  plan's own bound plus a restore window, not a fixed guess) and re-checks
  both durable receipts once at the deadline before declaring timeout;
  `receiptSnapshot()` reports only receipt-presence booleans, phase labels,
  bounded codes, and numeric exit/signal; `workerState()` adds two decisive
  bounded presence facts (`bootProcess.alive`/`identityMatch`, `appPresent`).
  Worker stdio is no longer captured at all (`stdio: ignore`), so no raw
  output can leak into diagnostics. Failure evidence is emitted as a bounded
  `PUBLIC_UPDATE_MAC_DIAGNOSTIC` line before the assertion and before cleanup,
  and readiness failures resolve through `boundedState()` so they always
  settle. The cleanup `finally` runs under `cleanupPreservingFailure()`: a
  cleanup error still fails the run but can no longer replace an in-flight
  primary failure. All rollback assertions (nonzero worker exit,
  `rolled-back`, absent commit, dead failed PID, restored digest, real
  relaunched window, sentinel, lock release) are unchanged.
- `tests/public-update-diagnostics.test.ts` — regression suite (below).

## Red/green evidence (Linux, portable)

Red (round 2, `tests/public-update-diagnostics.test.ts` before the review
fixes — the new tests reference not-yet-existing exports and the old
strict-write marker, so the suite failed to load / rejected):

```sh
npx tsx --test tests/public-update-diagnostics.test.ts
# SyntaxError: ... does not provide an export named 'sendHelperMessage'
```

Green (after review fixes — `artifacts/hard-review-fixes-r2.log`):

```sh
npx tsx --test tests/public-update-diagnostics.test.ts   # 15/15 pass
npx tsx --test tests/public-update-*.test.ts             # 39/39 pass
npx tsc --noEmit                                         # clean
npm run desktop:build                                    # clean
npm test                                                 # 799 pass, 0 fail, 10 skipped
```

Bundled-artifact check on Linux: `node desktop/build/public-update-helper.cjs
<abs>/plan.json` exits 1 with empty stdio and writes
`{"phase":"failed","code":"UNSUPPORTED_PLATFORM",...}` to `failure.json` when
the plan sits inside a `.prce-update-<64-hex>` workDir, and writes nothing
when it does not.

Round-2 review fixes verified by executable regression tests
(`artifacts/hard-review-fixes-r2.log`):

- Marker persistence is best-effort at the `phaseMarker` boundary: a
  transaction whose every marker write fails with real EEXIST still stops,
  restores, revalidates, relaunches and writes the durable `rolled-back`
  receipt, and still installs on the forward path; malformed labels still
  reject; checkpoint-port faults still propagate (pre-existing semantics).
- Dialog suppression is bound to the pre-commit probe window by an executable
  state-transition predicate: post-commit backend death or `launch()` failure
  shows the normal messages again; ordinary launches never suppress.
- A failing diagnostics read settles readiness callbacks deterministically —
  no unhandled rejection, `finally` cleanup still runs.
- A cleanup failure still fails the run but never replaces a primary failure;
  both causes survive (primary via propagation, cleanup via bounded code).
- `failure.json` is written only inside a transaction-shaped workDir; the
  readiness/receipt diagnostics emit only fixed codes, labels, booleans and
  numeric exit facts.

What the real-process tests establish (Linux fixtures, actual
`spawn`/`processIdentity`/`SIGTERM`/filesystem boundary):

- A SIGTERM-responsive failed launch is stopped and the old bundle restored
  with a durable `rolled-back` receipt.
- A SIGTERM-ignoring failed launch yields `STARTUP_STOP_TIMEOUT` recorded as
  `rollbackCode` beside the primary `STARTUP_TIMEOUT`, at stage `stop-failed`,
  with backup and lock preserved for recovery.
- A dead worker ends the receipt wait immediately; a live receipt-less worker
  honours its bound; a durable result written before worker exit or at the
  deadline boundary is observed; a helper failure announcement on a closed
  IPC channel stays contained.

## Still unconfirmed — the actual native Mac cause

Mac success has **not** been observed. No Mac run has executed this code. The
source defects above are confirmed and fixed, and an independent review's four
blocking defects are also fixed — but which defect, if any, produced run
`35116723866` is not proven. A 140 s timeout without worker state is not itself
evidence of a production defect, and the widened receipt bound must not be read
as the fix: if the next run passes only because work was legitimately slow, the
phase markers must show that, not silence it.

Unresolved hypotheses the next Mac run is designed to discriminate:

- **H1 — early silent worker error.** Any `UpdateError` before/inside the
  transaction (plan, old-exit, validation, launch) exited 1 with no record.
  Next run: `failure.json` carries the exact code; the raced wait reports the
  worker's numeric exit within seconds.
- **H2 — failed new instance could not terminate.** One candidate mechanism was
  the launch-path dialog await (a probe can never await user input — now bound
  to the pre-commit window only); another is the 10 s `stopFailedBoot` SIGTERM
  budget vs. the app's own quit path (`publicUpdates.close()` +
  `backend.stop()`, up to ~8 s). Next run discriminates: `boot-observed` +
  `stopping-failed` + `STARTUP_STOP_TIMEOUT` at stage `stop-failed` with
  `bootProcess.alive === true` means the new instance survived SIGTERM (remedy:
  the stop budget, not the dialog); `phase.restoring` present +
  `phase.relaunching` absent + `exit: "running"` means a slow-but-healthy
  restore, not a stuck process.
- **H3 — harness budget composition.** Legitimate helper work exceeded 140 s.
  Next run: the bound is `plan.deadline + 120 s` and phases show forward
  progress; a still-running worker is distinguishable from a dead one.
- **H4 — rollback-step failure after successful stop.** Restore/revalidate/
  relaunch failing used to surface only as generic `ROLLBACK_FAILED`. Next run:
  `failure.json` records `code` + `rollbackCode` + `stage`.

Evidence the next Mac run must collect (emitted as the bounded
`PUBLIC_UPDATE_MAC_DIAGNOSTIC` stderr line and in the assertion message):
`case`, receipt `kind`, worker numeric `exit`/`signal`, optional bounded
`reported` IPC code, receipt-presence booleans, observed phase labels,
`failure.json`'s `code`/`rollbackCode`/`stage`, and the presence facts
`bootProcess.alive`/`identityMatch`/`appPresent`. If cleanup itself fails, the
bounded `PUBLIC_UPDATE_MAC_CLEANUP` line preserves that cause without erasing
the primary failure.

## Mac re-run acceptance

Run the unchanged gate on the hosted macOS arm64 job (same invocation as
`docs/PUBLIC-UPDATER-MAC-GATE.md`):

```sh
export CI=true
export PRCE_PUBLIC_UPDATE_CI=1
export PRCE_PUBLIC_UPDATE_ZIP="$GITHUB_WORKSPACE/release/PR-Context-Explorer-<ver>-arm64.zip"
export PRCE_PUBLIC_UPDATE_MANIFEST="$GITHUB_WORKSPACE/release/public-mac.json"
export PRCE_PUBLIC_UPDATE_OLD_VERSION=0.5.99
npm run test:public-update:mac
```

Acceptance of the diagnosis requires one of:

- **Pass**: `PUBLIC_UPDATE_MAC_ACCEPTANCE` with both cases — then the timeout
  was harness-only (H3) or the termination defect (H2).
- **Fail with evidence**: the error message now contains the bounded snapshot —
  worker exit code/signal, receipt presence booleans, observed phase labels,
  and `failure.json`'s `code`/`rollbackCode`/`stage`. That snapshot identifies
  the exact failing phase; none of H1–H4 is then a guess.

Not acceptable: converting an unknown timeout into success, lengthening a wait
without the termination race, weakening any rollback assertion, or claiming the
production cause confirmed without the receipt evidence above.

## Follow-up — restored fixture exit timeout (run 35161645950)

Mac15 run `35161645950`, job `105013520046`
(`artifacts/github-job-105013520046.log`, ~lines 3193–3219): the gate passed
regression, packaging, manifest, smoke, positive install/commit, rollback
outcome, failed-new PID absence, restored bundle digest, and a real restored
old-app visible window with a new PID — then failed at
`tests/e2e/public-update-mac.mjs` "restored fixture exit" after the 30 s
identity wait, and cleanup subsequently emitted
`PUBLIC_UPDATE_MAC_CLEANUP {"code":"CLEANUP_FAILED"}`. The post-exit rollback
assertions (worker nonzero exit, lock release, sentinel preservation) were
never reached, so update acceptance was not — and still is not — proven.

The prior blind-receipt defect (H1–H4 above) is no longer the failure: the
receipt wait resolved and rollback completed. The new boundary is narrower —
the restored fixture main never read `gone` for `restored.pid` within 30 s,
and cleanup's SIGTERM path failed too. `processIdentity` saw a process-table
row the whole time: `kill(pid,0)` succeeds and `ps` lists a row for **both** a
live stalled process **and** an unreaped zombie, and neither responds to
SIGTERM. The original app is a direct Node child (reaped by the harness); the
restored app is launched by LaunchServices, so its reaping topology differs —
a persistent zombie is plausible but was not provable from this log.

### Linux zombie reproduction (real processes, RED)

With a live parent that never `wait()`s, a real zombie child showed exactly
the observed symptom shape: `process.kill(pid,0)` succeeds, `/bin/ps -p` lists
a row, SIGTERM is silently discarded, and the old `processIdentity` returned
the `uid + lstart + comm` identity string indefinitely — i.e. `null` (gone)
was unreachable. Reproduced in `tests/public-update-diagnostics.test.ts`
("real zombie process … must read gone"), which failed before the fix and
passes after.

### What changed (this boundary only)

- `desktop/public-update/helper.ts` — new bounded `processState(pid)`: a
  single fixed primary state letter from an allowlist, `null` only on
  ESRCH-verified absence, `"OTHER"` when unreadable/unrecognized; never raw
  `ps` output. `processIdentity` keeps the identical `uid + lstart + comm`
  string and returns `null` only on a verified-gone read: ESRCH absence, or
  the sole verified-terminal letter `Z`. Per Apple's published `ps` sources
  (`artifacts/apple-ps-print.c.txt`, `artifacts/apple-ps-ps.1.txt`), print.c
  emits the primary `Z` for SZOMB and appends `E` only as a secondary
  modifier (`p_flag & P_WEXIT && p_stat != SZOMB`), and ps.1 marks `Z` "a
  dead process" but `E` merely "trying to exit" — a blocked, still-live
  process it explicitly distinguishes from a zombie. `X`/`x` are likewise
  secondary flags (traced), never a completed state, so `E`/`X`/`x`/unknown
  reads all still count as present. An empty `ps` line is a read gap, not
  independently verified absence — `stateFromRead`/`identityFromRead`
  resolve it only through a fresh `kill(pid,0)`: ESRCH proves a raced exit,
  a still-present process reports `OTHER` or fails closed
  (`PROCESS_IDENTITY`), never permission to proceed. All existing consumers
  (old-exit wait, `stopFailedBoot`, gate `track`/`stop`, boot presence
  facts) inherit the correction: a zombie is dead, holds no files/sockets,
  and must not block or be signalled; a live process still requires exact
  identity before any signal.
- `scripts/public-update-fixture.mjs` — the fixture main now records bounded
  quit observability beside the quit file (`fixture-quit-state.json`, mode
  0600, atomic temp+rename, best-effort): `{pid, consumed, called,
  beforeQuit, willQuit, quit}` — fixed keys, booleans only, never an
  assertion input.
- `tests/e2e/public-update-mac.mjs` — both fixture-exit waits are wrapped: on
  timeout the gate emits `PUBLIC_UPDATE_MAC_DIAGNOSTIC` with
  `{quit, state, identityMatch, backend{alive,identityMatch}, exit, receipts,
  phases, failure}` and fails with that snapshot. `quit` is trusted only when
  the state file's recorded `pid` equals the process under wait; `backend`
  facts come from the runtime marker only when `marker.pid` matches. Cleanup
  scan: a fixture-path table entry that already reads gone (ESRCH or a
  verified-terminal zombie) is not signalled; a live entry — including one
  still trying to exit — must still pass `ownedAppIdentity` exactly.
  `stop()` unchanged: re-verifies identity before SIGTERM, refuses on
  mismatch, returns early when gone.
- `tests/public-update-diagnostics.test.ts` — real-zombie regression above,
  a bounded `processState` contract test (letter/`null`/`"OTHER"`, same
  pid-validation failures), an identity-stability test (identity string
  never contains the volatile state letter), and a state-read contract test
  over explicit simulated `ps` fixtures (`stateFromRead`/`identityFromRead`/
  `stateIsGone`: an empty line is a read gap, only ESRCH/`Z` reads gone,
  `E`/`X`/`x`/unknown stay present).

### Still unconfirmed — the native Mac cause

The zombie mechanism is confirmed **on Linux**; whether run `35161645950`'s
restored process was a zombie is **not** proven. The discriminating evidence
the next hosted Mac run now emits at this boundary:

- `state: "Z"` + `identityMatch: false` → the row was a dead process-table
  remnant (reaping topology), not a live app — the signature this change
  makes read `gone`. A process still trying to exit keeps a live primary
  letter (Apple's `E` is only a secondary modifier) — it reads present, and
  the other facts discriminate the stall.
- `state: "S"`/`"R"` + `identityMatch: true` + `quit.consumed: false` → quit
  file never polled (event-loop stall or watcher gap).
- `quit.consumed/called/beforeQuit: true` + `willQuit: false` + alive → quit
  entered `confirmQuit()` and stalled there (dialog or `desktopActive()`).
- `beforeQuit..quit: true` + `state` live → Electron emitted `quit` yet the
  process persists (backend stop or `app.quit` wedge); `backend.alive` +
  `backend.identityMatch` say whether the sidecar outlived it.
- `identityMatch: false` + `state` live + `quit` all true → stale/harness
  identity or PID reuse, not the fixture process.
- Receipts/phases/failure + worker `exit` as before — a late `result.json`
  vs. worker failure remains distinguishable.

Green evidence (Linux): `npx tsx --test tests/public-update-*.test.ts` 43/43,
`npm test` 803 pass / 0 fail / 10 skipped, `npm run test:desktop` 56+1 pass
incl. `desktop:build`. A stubbed-Electron real-process simulation of the
fixture shim showed `quit` phases discriminating a completed quit
(`{consumed,called,beforeQuit,willQuit,quit}: all true`, process exited) from
a `before-quit`-prevented stall (`beforeQuit:true, willQuit:false`, process
alive) — the `confirmQuit`-in-flight shape.

Acceptance is unchanged: `PUBLIC_UPDATE_MAC_ACCEPTANCE` requires the restored
exit **and** the worker nonzero exit, released lock, and sentinel assertions —
none of which this change weakens or skips. A diagnostic emission is evidence,
not success.

## Follow-up — live restored app stalled after before-quit (run 35169326502)

Mac15 run `35169326502`, job `105037332784`
(`artifacts/github-job-105037332784.log`, ~line 3203): the restored fixture
recorded `quit={consumed:true,called:true,beforeQuit:true,willQuit:false,
quit:false}` with `state=S`, `identityMatch=true`, a live identity-matching
backend, helper `exit={code:1}`, and no startup/commit/failure receipt. This
is a **live unchanged-identity** restored session wedged inside `before-quit`
handling — explicitly not a zombie.

### Root cause (real Electron + real sidecar, Linux — SANDBOX-DISABLED repro)

The local reproductions used `ELECTRON_DISABLE_SANDBOX=1` because this OCI
host's `chrome-sandbox` helper is not root-owned 4755 and Electron aborts
rather than run unsandboxed. Those logs
(`artifacts/hard-live-quit-red-electron.SANDBOX-DISABLED-NON-ACCEPTANCE.log`,
`artifacts/hard-live-quit-electron-e2e.SANDBOX-DISABLED-NON-ACCEPTANCE.log`)
are preserved as mechanism evidence only — **NON-ACCEPTANCE**: they are not a
passing normal E2E and say nothing about the sandboxed product.

Two layered defects, both reproduced against the compiled app with the real
IPC sidecar:

1. **Windowless modal confirmation.** `confirmQuit()` awaited
   `backend.active()` — conservative by design (`true` on unknown/timeout) —
   then called `dialog.showMessageBox` **without a parent window**. Per
   Electron 44 source, a parentless macOS dialog uses `[NSAlert runModal]`: a
   synchronous nested modal loop on the UI thread. On the restored app the
   renderer's bootstrap engine-setup scan holds `engineSetupBusy` (and
   therefore `desktopStatus().active`) for seconds after the window becomes
   visible, so the fixture's `app.quit()` landed while busy → the
   confirmation opened, nobody answered it → `beforeQuit` fired but
   `willQuit`/`quit` never did. Reproduced on Linux (sandbox disabled, see
   above): quit during an in-flight rescan → `exited:false`, dialog
   recorded, marker present, backend alive; consent resolves cleanly.
2. **Signals cannot rescue it.** On Linux the helper's SIGTERM never reached
   `process.on("SIGTERM")` — Electron's own termination path consumed the
   signal and routed it through `app.quit()` → `before-quit` (verified by a
   `process.on("SIGTERM")` probe that never fired while `before-quit` did).
   With a confirmation already pending, that signal-driven `before-quit` was
   prevented and the in-flight `confirmQuit` returned early (`quitPending`),
   so the process stayed `S` with a live backend — exactly the observed
   state. Independently, any throw inside the close path (e.g.
   `window.hide()` on an already-destroyed window) silently abandoned the
   quit the same way.

This signal-routing is a **Linux observation only**; whether a packaged
macOS app delivers SIGTERM to `process.on` is unverified and not relied on —
see the corrected semantics below.

### What changed (this boundary only, corrected after review)

- `desktop/quit.ts` (new) — `createQuitController`: a serialized quit state
  machine emitting bounded stages (`backend-status` → `confirm-open` →
  `confirm-resolved` → `updates-closing` → `backend-stopping` →
  `quit-dispatch`, or `quit-blocked`). Idle status quits with no dialog;
  active **and** unavailable both show the confirmation (fail closed).
  **Consent is never inferred from repetition**: a repeated `before-quit`
  while consent is pending deduplicates onto the in-flight confirmation —
  no stop, no quit, no second dialog — and the same dedup holds quit events
  during the serialized cleanup so nothing exits halfway through it. The
  only bypass is `handleSignal`, driven by an *observed*
  `process.on("SIGTERM"/"SIGINT")`: it grants shutdown through the same
  serialized close without ever opening a confirmation, and a dialog or
  probe resolving after that authorized close returns early instead of
  overwriting terminal state or running the close twice. A declined answer
  or a failed hook fails closed into `quit-blocked` and **re-arms** every
  latch (confirm/closing/requested), so a later quit retries instead of
  waiting on a stale or rejected promise; nothing in the controller can
  reject unhandled, and a throwing stage callback is swallowed as
  best-effort diagnostics.
- `desktop/lifecycle.ts` — new tri-state `status()`
  (`"idle" | "active" | "unavailable"`); `active()` delegates and preserves
  fail-closed semantics (`unavailable → true`). `status()` also resolves
  `unavailable` promptly on child exit/disconnect instead of waiting out
  the 2 s timer.
- `desktop/main.ts` — `before-quit` and SIGTERM/SIGINT delegate to the
  controller. `quitting` now means *cleanup in progress*; a separate
  `quitAuthorized` is set only where a quit may proceed, and only at the
  point each path's own cleanup completes: the controller's `appQuit` hook
  after serialized cleanup, the startup-fatal exit, and the two updater
  handoffs (`installPublicUpdate` quit callback and signed
  `quitAndInstall`). A second `before-quit` while cleanup runs
  is still prevented — it can no longer exit mid-close merely because
  `quitting` became true. The confirmation attaches to the visible window
  (`showMessageBox(win, …)` → non-blocking sheet on macOS, main loop stays
  responsive); **with no usable window it fails closed** (treated as
  "Keep Working") rather than risk a parentless `runModal` or silently
  consent. A plan-driven probe auto-consents (it must never await input);
  restored committed sessions always ask. `window.hide()` guarded against
  a destroyed window; bounded `desktop-quit-stage.json` breadcrumb
  (`{stage, at}` only — no dialog text, paths or env) names the blocking
  seam; on `quit-blocked` the session is restored (`quitting` cleared,
  window re-shown). The runtime marker gains `ready: true` only after the
  backend reports an explicit idle status, inside a real 110 s wall-clock
  deadline cancelled on quit (replacing the earlier counted-attempts loop
  whose worst case was ~550 s).
- `scripts/public-update-fixture.mjs` — the ready file additionally requires
  `desktop-runtime.json` `ready === true`, so the gate only quits a
  startup-complete idle session — not a visible-but-busy early window.
- `tests/e2e/public-update-mac.mjs` — the fixture-exit diagnostic now carries
  `quitStage` (the app's own breadcrumb), `until()` timeouts carry labeled
  bounded codes (e.g. `OWNED_APP_EXIT`), and readiness asserts include
  `ready === true`. The restored-exit assertion is unchanged and unskipped.
- `tests/desktop-quit.test.ts` — controller controls over a real IPC child:
  idle no-dialog quit, active consent/decline/re-prompt, unavailable fails
  closed, **duplicate-quit dedup while consent pending (no stop/quit before
  an affirmative answer)**, held cleanup during a duplicate quit, trusted
  signal during pending confirm with late-answer no-overwrite, signal
  during in-flight probe skipping the dialog, signal-only close, no
  double-close, status throw / dialog rejection / each close-hook rejection
  / `appQuit` throw all failing closed and re-arming with zero unhandled
  rejections, throwing stage callback not aborting shutdown, and `status()`
  tri-state over a real child.
- `tests/e2e/desktop-quit-electron.mjs` — real compiled app + real sidecar,
  **sandbox always enabled**: the suite refuses `ELECTRON_DISABLE_SANDBOX`
  (ambient → explicit BLOCKED-skip, never inherited by the child) and skips
  BLOCKED when the real sandbox cannot initialize on the host — it never
  claims a green run from a sandbox-disabled launch. On a capable host it
  asserts: busy quit pends on a window-attached confirmation at
  `confirm-open` and consent completes to `quit-dispatch`; a duplicate
  `app.quit()` during the pending confirmation neither exits nor re-prompts,
  and a routed SIGTERM either stays pending consent (Linux routing through
  `before-quit`) or exits `{code:0}` via the trusted `process.on` path;
  declining keeps the app live (`quit-blocked`, marker retained) and a
  later quit re-asks; idle quit exits directly.

### Review closure — r4 L1: menu quit re-admitted through the before-quit seam

Round-4 review flagged one blocking regression: the "Quit for External
Update…" menu item called `quitCtl.handleBeforeQuit()` directly, so a
user-confirmed quit skipped the install-admission guard that lives only in
`before-quit` — during a `downloaded`/`preparing`/`ready` transaction it
would tear down the prepared install the invariant says a quit must never
interrupt. The confirmed menu item now ends in `app.quit()`, so the same
admission seam decides as for every ordinary quit: ignored entirely while
`publicOperation` owns an install-owned phase, otherwise prevented and
handed to the controller. The seam moved into
`createBeforeQuitHandler`/`INSTALL_OWNED_PHASES` (`desktop/quit.ts`) so it
is exercisable without Electron: `tests/desktop-quit.test.ts` drives the
real handler through a minimal Electron-contract fixture (`app.quit()` →
`before-quit` → exit iff no listener prevented) and asserts the quit is
dropped with the controller untouched in every install-owned phase,
admitted during network phases and in normal idle (one exit, via the
authorized re-dispatch), and that repeated quits during the serialized
close stay held for a single exit. `tests/desktop-composition.test.ts`
pins the menu → `app.quit()` wiring as a source invariant — a text pin
only, not proof of native integration.

### Remaining native unknown

`[NSAlert runModal]` blocking is established from Electron source and
inference, not observed on macOS hardware — the window-attached sheet removes
the mechanism regardless, and the no-window path now fails closed instead of
risking a parentless modal. Linux signal-routing observations do not prove
macOS mechanics: if a Mac `SIGTERM` never reaches `process.on`, a
pending-confirmation session stays live (fail closed) and the stage file
names `confirm-open`; the readiness gate is what keeps the restored fixture's
quit on the idle no-dialog path. If a future Mac run still stalls, the stage
file names the exact seam (e.g. `confirm-open` vs `backend-stopping`)
instead of a generic timeout.

Mac acceptance is **not** claimed: the hosted run has not executed this code
and local real-Electron E2E is BLOCKED on this host (sandbox cannot
initialize; nothing was run with the sandbox disabled for this correction).
The next run passes only if the restored fixture exits, the worker exits
nonzero, the lock is released, and the sentinel survives.
