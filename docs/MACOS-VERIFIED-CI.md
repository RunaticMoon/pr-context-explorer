# Verified Apple Silicon CI build

- Source commit: `a4e7d62e9f5a24d1c103a8103549d1ea71b5e6d0`
- Actual run: https://github.com/RunaticMoon/pr-context-explorer/actions/runs/34949907958
- Artifact: https://github.com/RunaticMoon/pr-context-explorer/actions/runs/34949907958/artifacts/10388188310
- Artifact ID: `10388188310`; private, unexpired when checked; 348557182 bytes; contains the DMG and ZIP produced by the workflow.
- Local raw log: `artifacts/github-job-104318132721.log`.

## Actual execution

The final mandatory outcome gate recorded regression, desktop and package outcomes all `success`; artifact upload succeeded and its record was independently read back via GitHub API.

- Mac top-level suite: 539 passed, 0 failed, 10 platform-specific skips.
- Desktop tests: 24 passed, 0 failed.
- Compiled backend smoke: 1 passed.
- Real Electron window/sandbox/preload/normal quit smoke: 1 passed.
- Packaged native ACL helper plus real packaged app/backend lifecycle: 2 passed.
- Darwin confinement, root-child/outside/symlink denial, system configuration handling, process timeout, verified proxy TLS and pinned Codex/Claude help/status probes passed.

These are distinct suites; no deduplicated aggregate is claimed. The native CLI checks were credential-free and the TLS check made no model API request.

## Distribution limits

This is an Actions build artifact, not a published GitHub Release or a completed automatic-update rollout. The workflow retains artifacts for seven days. Source and assets remain private. The app is personal unsigned/ad-hoc distribution: no Developer ID signing or Apple notarization is claimed. Users may encounter Gatekeeper.

Actual verification covers the macOS 15 Apple Silicon runner and fixed ICU 76 configuration. Other macOS versions, authenticated model inference, private GHES/Jira organization compatibility and personal update installation/rollback still require their own verification. The final installer must not be described as universally compatible or fully authenticated-analysis verified.
