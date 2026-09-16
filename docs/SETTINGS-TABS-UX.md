# Unified connection and engine settings

## Behavior

- Fresh `/`, legacy `?page=connections`, and `?page=live-connections` open real settings. The config-only Stage 1 form is removed. Explicit Demo opens `?page=demo`; fixture PR list/workspace remain available.
- One root session/CSRF bootstrap remains shared. A failed demo snapshot request does not block live settings.
- GitHub, 분석 엔진, Jira are semantic tabs with `aria-selected`, `aria-controls`, associated panels, roving focus, arrow keys, Home and End. Inactive panels are hidden from the accessibility tree.
- GitHub initially shows Web URL and PAT only. Derived API configuration and legacy gh/env/public configuration remain collapsed advanced sections.
- Approved GitHub connections display `account · GitHub` or `account · host/context-path`. Original IDs remain option values and API/cache identities; a collapsed read-only metadata section contains the internal ID. Full host is available as the selector tooltip. Jira labels use account/site instead of connection IDs.
- Engine configuration is full-width rather than nested in a workspace sidebar. A single radio selector controls the engine. Only its selected engine exposes authentication actions and collapsed diagnostics; other engines show compact status. Missing CLI, compatibility, isolation and authentication remain blocking states, never green availability claims.
- Workspace retains its compact engine status/configure link and existing explicit transmission consent/run controls. Settings navigation merges query fields and retains the parent state, including pinned snapshot, commit, file, range, tour and Q&A. Return restores the workspace without inference.
- Engine discovery remains mounted once, so changing tabs does not rescan. Explicit refresh invalidates readiness immediately, including error paths. GitHub/Jira unsubmitted token forms unmount on tab changes; the mounted engine form clears its password DOM value when inactive. No password is persisted to browser storage.
- Styling is scoped to `.settings-shell`; engine diagnostic definition-list resets do not affect evidence layouts. Korean font remains bundled Noto Sans KR. Links use readable cyan rather than browser-default dark blue.

## Verification

The fresh-root semantic-tab test was first run against the old build and failed because no GitHub tab existed. Final execution, after rebuilding served assets:

- `npm run build`: passed (`tsc --noEmit` and Vite).
- `npm test`: 719 tests, 709 passed, 10 skipped, 0 failed.
- `npm run test:e2e`: 20 passed.

Browser coverage includes real loopback session/CSRF and HTTPS GitHub/Jira protocol fixtures, explicit authentication consent and token deletion/error fail-closed readiness, legacy route/back navigation, demo isolation, Q&A/settings round-trip preserving all scoped query fields, one engine status read across tab switches, zero inference calls from settings navigation, unchanged opaque option value with a friendly label, ephemeral drafts, keyboard tabs, no horizontal page overflow, long API input and scroll-reachable actions.

These are synthetic provider/transport fixtures, not authenticated access to the pictured account or live model inference. `jude-moon` in the display test is a synthetic label with a fake internal ID. Real local engine discovery in the general settings screenshots reports installation required; it does not establish macOS engine availability. Existing security tests were retained.

## Browser screenshot artifacts

11 real Chromium screenshots are generated under `artifacts/settings-ux/` (ignored runtime artifacts, not source assets):

| Set | Viewport | Notes |
| --- | --- | --- |
| `github-desktop.png`, `engine-desktop.png`, `jira-desktop.png` | 1280×800 | Full-page capture |
| `github-medium.png`, `engine-medium.png`, `jira-medium.png` | 960×720 | Full-page capture |
| `github-narrow.png`, `engine-narrow.png`, `jira-narrow.png` | 760×700 | Root font 17.5px, 125% font simulation, full-page capture |
| `claude-FAKE-auth-desktop.png`, `claude-FAKE-auth-narrow.png` | 1280×800 / 760×700 | Selected Claude token form, compact Codex, synthetic setup status; no inference |

Desktop/narrow screenshots were visually inspected with image analysis: Korean rendered, controls stayed inside cards, selected-only engine detail worked, and no visible clipping was found. Initial inspection identified a low-contrast installation link and irrelevant GitHub copy under other tabs; both were fixed and captures regenerated. Full-page images are taller than viewport height; long Jira/authentication forms intentionally scroll rather than hiding actions.

## Remaining platform gate

This Linux/browser change does not alter provider detection, executable consent, isolation, credentials, packaging or release workflows. Actual macOS 26 packaged-app readiness, sandbox availability and positive real-provider inference still require their separate platform/authorized gates. No remote account operations, real credentials, commit or push were performed.
