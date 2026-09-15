# Diagnostic system-policy preflight

The diagnostic entry points use the same `validateMacSystemPolicyReads` host
preflight as production. Building a Seatbelt profile or A/B plan is **not launch
authorization**.

- `macos-ai-diagnostics.ts` awaits preflight immediately after the Darwin arm64
  check, before A/B dispatch, metadata, discovery, scratch creation or startup.
- Exported `runRootDirectoryAB` independently awaits preflight before executable
  discovery, so calling it directly cannot bypass the main entry check. It checks
  again immediately before each direct `runBoundedProcess(plan.request)` launch.
- Ordinary diagnostic startup still uses `runSeatbeltCommand`, including that
  function's existing per-launch preflight. Production code, profile generation,
  environment, process/output limits and PID/crash attribution are not changed
  by this integration. Host `/usr/bin/log` readers are not target CLI launches.

This is absence-only compatibility, not a system-policy loader. Present configs
(including empty files and dangling links), untrusted ancestors and unknown
metadata failures block according to the production validator. Diagnostics do
not read configuration content, suppress policy, provide path/environment
fixtures, or retry a failed launch with a wider profile. Errors remain bounded
code-only reports: entry failures reach `fatal`; per-variant failures retain the
A/B error report without spawning that target.

## Regression evidence

`tests/macos-diagnostic-policy.test.ts` adds seven tests. Static entry assertions
require awaited checks before main dispatch and standalone A/B discovery, plus a
fresh check before each A/B target spawn. On Linux, actual calls to both entry
points use the real validator and real filesystem after temporarily simulating
only the Darwin arm64 platform check. Missing trusted macOS ancestors cause
`sandbox_unavailable`; main emits only its host record and A/B emits nothing.
There are no injected production paths or replacement guard functions. These
entry tests are skipped on other platforms and are **not Darwin verification**.
The system-policy test suite separately covers modeled present, missing and
unknown metadata with the real validator's existing metadata test seam.

TDD evidence: initial main tests failed (5/5), then passed (5/5); standalone A/B
additions failed (2 new failures, including discovery's `cli_missing` instead of
the required preflight error), then all seven passed. Full Linux `npm test`:
460 tests, 452 passed, 8 skipped, zero failures. `tsc --noEmit` and
`git diff --check` passed.

## Next real-Mac capture

Run on Darwin arm64 with the pinned native Claude installation:

```sh
npx tsx scripts/macos-ai-diagnostics.ts --startup-help-only=claude
```

Use this single credential-free help capture rather than the historical
`--startup-ab-root-directory` experiment. The parent workflow owns that switch;
this integration does not edit workflows or claim a Mac run. The command retains
fixed `--help`, fresh private state, the unchanged production profile/hash,
10-second/128-KiB execution bounds and target/log-reader PID separation.
A present system configuration intentionally blocks compatibility; do not delete,
read, ignore or weaken policy to obtain a help result. Successful profile
construction and Linux tests do not establish Claude help compatibility or
Darwin confinement.
