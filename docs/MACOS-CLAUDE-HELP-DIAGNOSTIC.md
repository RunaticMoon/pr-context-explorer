# Claude help-only SIGKILL diagnostic

## Evidence and next Mac step

Actual Mac CI run `34936979728`, job `104276926739`, at repository baseline
`9c1064c` already separates two startup paths. In
`artifacts/github-job-104276926739.log`:

- Line 1014: Claude `--version`, PID 2053, prints `2.1.270 (Claude Code)` and exits 0.
- Lines 1023–1024: capability checks run `--version` (PID 2176, exit 0) and
  `--help` (PID 2175, empty stdout/stderr, null exit code, `SIGKILL`).

The old version-only crash collection cannot explain the help PID's kill. The
previous early LIBIGNITION/SIGABRT/root-directory failure is not this failure.
Do not repeat the historical root-directory A/B or grant new permissions.

On the existing trusted Darwin arm64 checkout with its pinned Claude binary and
installed dependencies, run only:

```sh
node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --startup-help-only=claude > artifacts/claude-help-only.jsonl 2>&1
```

Run from the repository root; `artifacts/` must exist. A kill intentionally returns
nonzero while retaining diagnostic JSONL. Do not replace this command with a full
capability/confinement CI run. Node/OpenSSL and Codex managed-policy investigations
are separate; review this root-cause evidence before resuming full Mac CI.
No remote dispatch, install, credential lookup, commit or push is part of this step.

## Contract

- The exact flag is exclusive. Unknown, duplicate and combined flags are rejected;
  only Claude is supported. Existing no-argument and version-only modes retain
  their selection behavior.
- Launch exactly one Claude command with fixed argv `["--help"]`, no version
  prelaunch, auth status, prompt, inference, fallback profile or A/B variant.
- Reuse `runSeatbeltCommand` and the unchanged production profile generator.
  Fresh canonical private scratch/HOME/work/config directories are created each
  invocation and removed afterward. The production clean environment is built
  from fixed values, not parent environment or private user settings. No auth,
  schema or proxy inputs are supplied. No environment values are dumped.
- Bound Claude execution to 10 seconds, 65,536 bytes each stdout/stderr and
  131,072 bytes combined. Credential-free binary help is retained as JSON-escaped
  text within these existing caps. Timeout/output-limit errors are harness
  failures, not evidence of a spontaneous OS SIGKILL.
- Emit the exact full profile, numbered profile, SHA-256, executable, actual
  host-spawned PID, argv, execution start/end timestamps, exit and native signal.
  The startup contract is explicitly not confinement/runtime verification.
- On a nonzero/null result collect fresh `.ips` candidates for that same PID and
  launch window, not another `--version` process. Existing caps remain: two fixed
  DiagnosticReports directories, 8-second search deadline, five attempts, 24
  candidate reads, 2 MiB per file, at most three verified summaries. Summaries
  allowlist exception/termination/ASI/frames; they do not dump memory/environment.
- PID/time-correlated reports whose full executable differs (including a
  sanitized Apple-shaped path) remain rejected and explicitly
  `unverified-executable-match`. A displayed `/Users/USER/` path alone does not
  prove Apple anonymization or target identity.
- Query actual unified logs without sudo for the same PID and bounded last-two-
  minutes scope, with 10-second timeout, 64 KiB stdout and 4 KiB stderr caps.
  The existing predicate already includes `kernel`, `sandboxd`, `ReportCrash`,
  `amfid` and `syspolicyd` messages containing target PID markers, plus the target's
  own processIdentifier. Output labels `targetPid` separately from `logReaderPid`;
  system process messages require execution-time/PID correlation, not attribution
  to the log reader. Missing, redacted, denied or capped logs do not prove absence
  of an OS denial.

## Interpret before changing policy

These are hypotheses, not decoded causes:

1. **Code-signing / executable memory mapping:** help may exercise runtime paths
   that version does not. Look for an exact-PID kernel/AMFI invalid-page,
   signature, mapping or CODESIGNING termination reason. SIGKILL alone establishes
   none of these and does not justify a JIT grant.
2. **Seatbelt operation denial:** look for a target-PID denial near the launch,
   with the specific operation and path/service. An unrelated denial is not the
   cause; absence in accessible logs does not exclude it.
3. **Resource pressure or other termination:** look for a direct kernel reason
   or correlated report. A harness timeout/output cap must not be mistaken for
   the spontaneous kill seen in CI.

A SIGKILL need not produce an IPS report. A direct, time-correlated kernel message
naming the actual help PID and termination reason can establish the reason even
with zero matched IPS files. Preserve that evidence instead of loosening IPS
identity filters. If both channels are unavailable or inconclusive, report the
cause as unresolved. Never remove quarantine, alter signing, use sudo, or add
blanket JIT/fork/Mach/filesystem permissions to obtain a passing diagnostic.

Linux unit tests verify flag/argv/bound contracts, signal/PID preservation and IPS
filtering only. They cannot capture or identify this Darwin kill. Actual new Mac
help-only output and independent root review remain required.
