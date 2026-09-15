# Mac CI cancellation and bounded validation

Actual run: https://github.com/RunaticMoon/pr-context-explorer/actions/runs/34929982015
Commit: `a6ab4ad328f31f0bd6b591b91b1902d46aad8cd9`
Evidence: `artifacts/github-job-104256009589.log` (local diagnostic log; not release proof).

## Observed

- The local watcher reached its deadline while the remote job was still in progress.
- The actual desktop step remained active for 1545 seconds at inspection. The Electron Node test had already reported its 60000 ms timeout, but the process did not exit.
- Parent requested cancellation of this exact run (HTTP 202), then read back `completed` / `cancelled` before downloading final logs.
- Actual desktop unit/compiled-runtime checks completed before GUI smoke. Native AI execution still failed five mandatory Darwin tests: immediate SIGABRT with empty stdout/stderr. Those are not successful tests despite the API step conclusions after `continue-on-error`.
- The diagnostic-only `(with report)` modifier itself failed SBPL compilation. Its OS-log queries targeted that failed diagnostic PID rather than the actual aborted native process, so an empty result cannot establish absence of native crash evidence.
- Final outcome gate failed and artifact upload was skipped. No installer/release is claimed.

## Parent workflow change

All executable validation steps now have explicit deadlines: installation 8 minutes, credential-free diagnostics 3, regressions 5, desktop 6, packaging 10, final outcome gate 1. Job cap is 30 minutes. These are ceilings, not performance claims. The artifact gate still requires every mandatory original step outcome to be `success`.

`tests/distribution-ci-gate.test.ts` first failed on missing deadlines, then passed after the workflow edit. Combined CI/release guard suite: 7 passed on Linux.

## Pending

Desktop bounded cleanup/stage diagnostics and correct native crash evidence are separately being addressed. These changes require another actual Mac run; no runtime confinement permissions have been relaxed to conceal the failures.
