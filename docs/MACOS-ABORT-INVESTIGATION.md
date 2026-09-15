# Native macOS SIGABRT investigation

## Evidence, not a confinement fix

Source: actual GitHub Actions run **34932821826**, job **104264434466**, checkout **9dc19c05b8dfbe499cef6c47c03e067900849937**. Local evidence: `artifacts/github-job-104264434466.log`. No new remote run was initiated for this investigation. Production `src/server/ai/*` files were read only.

| Target | Actual child PID | Evidence lines | Observed result |
| --- | --- | --- | --- |
| Node | 13574 | 976–979 | Empty stdout/stderr, null exit code, SIGABRT; kernel corpse and ReportCrash fatal 309 formulation |
| Codex | 13626 | 997–1000 | Same termination and ReportCrash formulation |
| Claude | 13874 | 1015–1018 | Same; exact-PID `deny(1) file-read-data /` immediately before corpse event |

These are the host-spawned child PIDs, not the later `/usr/bin/log` reader PIDs. Unified logs show sandbox compilation, sandbox application, and the named native executable's corpse. This is not the earlier invalid-profile compiler failure. “Fatal 309 report” identifies a report formulation, **not a dyld termination reason**.

All three crash searches report `matches: 0, reads: 4`. Reads are attempts, not distinct files: only successful paths enter the existing `seen` set, so one rejected file can be read four times. The log contains no candidate identity/time metadata, parse error, or rejection reason. No local `.ips` artifact was found. Therefore the original report rejection and actual termination namespace/message remain unknown.

### Clock discrepancy: confirmed, but not the demonstrated cause of rejection

Claude's caller `startedAt` is **1789450096619** (05:28:16.619 UTC). Its exact-PID sandbox compile event is **05:28:16.267250**, 351.75 ms earlier; ReportCrash formulation is **05:28:16.357546**, about 261.454 ms earlier. This is a disagreement between timestamp sources; it is not evidence that the caller literally spawned a process before calling the launch function, nor proof of a particular realtime adjustment mechanism. Node and Codex show the same ordering discrepancy.

The parser at the investigated commit already permits **±1000 ms** around the launch interval for both `procLaunch` and `captureTime`. The observed discrepancy fits that existing allowance. A synthetic parser regression based on these actual clock values passes without widening it. This regression is **not a recovered IPS report**.

The separate file-mtime prefilter remains strict (`mtime >= startedAt`); four reads show that some candidate attempts passed it. No evidence establishes that this filter discarded the true report. Neither timestamp nor mtime acceptance was broadened.

## Ranked, falsifiable hypotheses before any permission change

1. **Shared dyld/early runtime initialization failure.** All three different native engines abort before output under the same profile. Prediction: the exact-PID/exact-executable IPS exposes a `DYLD` termination reason, loader frames, or an early libSystem assertion. First discriminator: termination namespace/details/reasons, ASI and faulting frames. Existing profile grants `/usr/lib`, framework roots and `/System/Library/dyld`; the presence of another cache path does not establish a missing required permission. Do not add Cryptex or Mach grants speculatively.
2. **A fatal filesystem-dependent initialization path, potentially the Claude root-directory read.** The Claude root denial is real; its causal role is unproven, and corresponding root denials are not present in the captured Node/Codex logs. Prediction: Claude's ASI/frames tie the abort to a required root open/read or loader path operation. A denied optional probe could instead be harmless. Root data access is not equivalent to the already-granted root metadata access. Do not grant `(subpath "/")`, broad file reads, or even a new literal-root data grant until the termination evidence and parent review justify it.
3. **Signing/platform enforcement.** Prediction: a matched crash termination names `CODESIGNING` or another platform enforcement namespace, or exact-PID amfid/syspolicyd evidence identifies it. Current SIGABRT/corpse evidence alone does not establish this; no signing/quarantine weakening is warranted.
4. **Runtime-specific assertion (including denied IPC/process operations) rather than loader failure.** Prediction: a matched report names runtime/application frames and a corresponding assertion/denied service. Shared early failures make three unrelated application bugs less attractive. No current evidence supports a Mach lookup, process-fork, or network grant.

No production permission change should precede this discrimination. Absence of a captured denial is not proof of permission success.

## Diagnostic-only repair

`scripts/macos-ai-diagnostics.ts` now emits bounded `*-crash-candidate-rejected` records for attempted reads:

- Fixed reason enum: invalid JSON, oversized payload, metadata rejection, or identity/time mismatch.
- Numeric file size and mtime delta; identity **booleans**, not a rejected report's PID/path; parsed launch/capture deltas or null for invalid times.
- At most the existing 24 read attempts per target. No rejected report text, environment, registers, memory sections, or candidate filename is returned.
- Existing exact PID/full executable comparisons, ±1 second body window, strict file freshness, no-follow open, fixed 2 MiB read cap, retry and scan bounds remain intact.

This repairs the **proven observability gap**, not an assumed crash-format or clock bug. Successful summaries still expose only the existing bounded exception, termination, ASI and frame fields.

## Smallest next Mac diagnostic

On the same prepared Darwin arm64 CI checkout, with the existing pinned native CLI installation and no credentials:

```sh
node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --startup-only=claude
```

This performs one Claude `--version` launch under the unchanged production profile, captures its actual PID/signal, attempts the existing sanitized IPS summary, and reads exact-PID unified logs. It skips Node/Codex launches and the later repeated confinement/capability probes. It still exits nonzero on failure; collecting evidence is not success. `--startup-only=node` or `--startup-only=codex` are available for a subsequent discriminating comparison, not a mandatory full repeat.

Acceptance for the next run: a matching summary with a real termination message/ASI/frames. If no report matches, use the new reason/boolean/delta evidence to identify the precise collector obstacle. Invalid JSON suggests incomplete/unsupported report layout; matching identity with out-of-window times calls for examination of actual deltas; mismatched identity calls for investigating the candidate, not dropping identity checks. If collection remains unavailable, report that blocker rather than fabricating a termination message or widening confinement. Do not upload raw IPS or environment dumps.

## Local verification and limits

- Test-first rejection callback and file-metadata regressions each failed on the original implementation, then passed with the diagnostic repair.
- Startup-only argument selection regression failed before implementation, then passed; unknown/duplicate options are rejected.
- `tsx --test tests/ai-runner.test.ts`: **14 passed, 0 failed**.
- `tsc --noEmit` and `git diff --check`: passed.
- Actual local invocation of startup-only mode correctly reports Linux arm64 as unsupported and exits 1. No native Mac success or recovered termination message is claimed.
- Full `npm test` on the concurrently edited working tree: **337 tests, 330 passed, 1 failed, 6 skipped**. The failure is in another workstream's `tests/desktop-smoke.test.ts` (`supervisor needs a failure-message-aware result, not exit alone`), not the owned diagnostic/runner tests. Output: `/tmp/prce-abort-investigation-tests.log`. Darwin runtime tests were explicitly skipped on Linux.
