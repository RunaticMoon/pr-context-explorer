# macOS native crash diagnostics

Run on an ephemeral, credential-free **Darwin arm64** runner with standalone Node and the pinned native engines installed:

```sh
npx tsx scripts/macos-ai-diagnostics.ts
```

Exit status remains nonzero when startup, confinement, discovery or capability checks fail. This is evidence collection, not a workaround. Running under Linux intentionally reports `unsupported`; it does not validate Seatbelt. Do not use Electron's `process.execPath` as standalone Node.

## Why the previous evidence was misleading

`artifacts/github-job-104256009589.log` records empty stdout/stderr and `SIGABRT` for the production-profile Node, Codex and Claude launches. The separate reporting launches instead exited 65 with `report modifier does not apply to deny action`. Their PIDs (5779, 6025 and 6052) belonged to the failed profile compiler, not the aborted native executions. Empty logs scoped to those compiler PIDs do not explain the native aborts.

The diagnostic now runs only the unchanged production `runSeatbeltCommand` profile (`(deny default)`), prints that profile, and uses the **same result's host-spawned PID and termination signal**. `sandbox-exec` normally execs the native executable without changing PID; an IPS must additionally match the expected full executable path, so a pre-exec compiler crash is not mislabeled as a native crash. There is no diagnostic profile, reporting modifier, permission override or new production request option. The optional `ProcessResult.pid` is result metadata only; existing output caps, deadlines, cancellation, process-group cleanup and errors are unchanged.

## Evidence emitted

- `<engine>-credential-free-startup`: PID, expected executable, host launch-window timestamps, exit code/signal and byte-bounded stdout/stderr.
- `<engine>-fresh-crash-summary`: only a fresh matching `.ips` from the account-database home `~/Library/Logs/DiagnosticReports` or `/Library/Logs/DiagnosticReports`. Candidate names must begin with the expected executable basename plus `-` or `_`. File modification time must be fresh; parsed PID and full `procPath` must match; `procLaunch` and `captureTime` must fall within the recorded launch window with one second of timestamp tolerance. Invalid/missing timestamps, PID reuse, other executable paths and malformed reports are rejected.
- Summaries allowlist exception, termination (including bounded DYLD details/reasons), application-specific information (`asi`), and up to 16 faulting-thread frames with image names. No whole report, environment, argv, register state, memory map, memory contents or auth/config file is printed. Free-text diagnostic fields are length-limited and control characters removed; every output record is JSON-encoded, never evaluated or interpolated into shell source. These fields are diagnostic text, not a general-purpose secret scrubber: use only the credential-free disposable runner.
- `<engine>-crash-search`: explicit match/read counts and a non-conclusive absence status. Search uses up to five passes with four one-second waits, an eight-second search deadline, at most 2,048 directory entries per directory/pass, 24 fresh candidate read attempts and three summaries per engine. Each candidate is a regular non-symlink file opened read-only with `O_NOFOLLOW`; size is checked on the opened descriptor and reads use a fixed 2 MiB plus one-byte overflow buffer. Oversized files are rejected. No recursion, archived reports or broad user-home search. Host filesystem calls rely on normal local filesystem responsiveness.
- `<engine>-os-log-scope` and `<engine>-sandbox-crash-log`: `/usr/bin/log show --last 2m --style ndjson --info --debug --predicate ...` for the **actual launch PID**, either direct `processIdentifier` attribution or PID-delimited messages from kernel/sandbox/crash/signature services. The predicate contains only a validated integer PID, not executable names or source text. Execution is limited to ten seconds, 64 KiB stdout and 4 KiB stderr.

Crash files may be delayed, suppressed, inaccessible or larger than the cap. Unified logs may omit/private-redact denial messages; unprivileged system/kernel access can be denied. Those cases are reported, never treated as proof of no denial. The script does **not** invoke sudo, request root, modify system logging settings or change Seatbelt rules. If an operator already has authorized read-only elevation, they may separately repeat the printed narrow log query with sudo; this is not a runtime requirement. The fresh IPS search runs independently of log availability.

## Interpreting the next Mac run

Correlate startup PID/signal with matching IPS exception, termination reason and top frames, then the narrow unified log. This should distinguish loader/signature termination, a libc/runtime assertion and a denied startup operation. Default-denied process inspection (`process-info*`) or task-port operations (for example `mach-priv-task-port`) are hypotheses **only**, not findings. An empty stderr or `SIGABRT` alone does not justify adding them. Do not guess Mach rules or broaden process, filesystem, network or IPC grants. Require actual matching Darwin evidence, then reproduce and test any proposed least-privilege change against all confinement negatives.

Local regression command:

```sh
npx tsx --test tests/ai-runner.test.ts
```

The tests exercise real child PID/signal capture, production-profile regression checks, synthetic IPS parsing/redaction/bounds and real-file stale/symlink/size rejection. Synthetic fixtures are parser tests, not claimed Darwin crash evidence. A fresh Mac execution is still required to identify the native abort's cause.
