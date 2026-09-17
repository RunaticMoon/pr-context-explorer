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
