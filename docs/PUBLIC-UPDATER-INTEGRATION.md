# Public updater desktop integration

Verified on Linux 2026-09-16; real macOS replacement remains a separate acceptance gate.

## Main/renderer contract

- `prceDesktop.status()` retains the legacy `updates` field and adds `publicUpdates: {enabled, channel, reason?, phase, version?, received?, total?, errorCode?, lastChecked?}`. Installed version and exact boolean preferences are top-level fields.
- Finite preload methods: `checkUpdate()`, `downloadUpdate()`, `cancelUpdate()`, `installUpdate()`, `updatePreferences(autoCheck, autoDownload)`. There is no general invoke/send, renderer URL, path, credential, target-version or busy-state input.
- Both IPC handlers require the owned WebContents, its actual main frame and the fixed loopback root document. SPA query navigation is permitted; foreign origin/path, subframes, other windows and extra command fields are rejected.
- Public personal builds default on at compile time (`PRCE_PUBLIC_UPDATES=0` disables). Runtime requires packaged Darwin arm64 and a non-signed build. Signed private updates remain a separate native-only channel. Development/browser contexts do not contact the updater network.
- Preferences default to automatic checks enabled and automatic downloads disabled. First check is deferred 30 seconds after readiness; subsequent checks use one six-hour timer. Downloaded/preparing/ready updates are not erased by periodic checks. Backend/renderer failure stops scheduling.

## Admission and startup

The backend IPC admission operation performs the active-work check and lock synchronously in the same event loop. Active queued/running jobs, engine setup and in-flight mutating API calls refuse the lock. Frozen POST/DELETE requests return 503; job creation checks the lock again after awaits. HTTP cannot unlock admission.

Installation uses a main-owned target version in a native confirmation, then acquires admission, awaits `prepareInstall()` (helper-ready, not spawn), and keeps admission closed through backend shutdown and quit. BUSY preserves the downloaded update and never cancels analyses. Failed/declined preparation unlocks; signed native installation also holds admission through consent and shutdown.

Startup awaits `registerStartup(canonicalBundlePath, app.getVersion())` before starting the backend. The backend starts frozen before listening. Main waits for `loadURL`, checks runtime readiness, awaits `acknowledgeStartup()` including helper commit, then unlocks and shows the window. There are no custom receipt or acceptance-test bypass arguments.

## Build and tests

`npm run desktop:build` bundles main dependencies (including pinned yauzl) and produces standalone `desktop/build/public-update-helper.cjs`. Electron Builder copies the helper to `Contents/Resources/public-update-helper.cjs`, outside ASAR, and refuses a missing/empty/symlink helper. It is signed app resource data, not another Mach-O binary. The four-file ASAR allowlist is unchanged; bundled dependency licenses are included in THIRD-PARTY-NOTICES.

Executed:
- `npm test`: 776 tests, 766 passed, 10 platform skips, no failures.
- `tsx --test tests/desktop*.test.ts`: 43 passed, including standalone helper launch outside checkout, finite payload validation, native denial/BUSY and admission tests.
- `tsc --noEmit`, full desktop build, and compiled standalone backend test: passed. Runtime test proves startup admission returns 503 until trusted IPC unlock.
- `playwright test tests/e2e/desktop-updates.spec.ts tests/e2e/settings.spec.ts --workers=1`: 6 passed. Update bridge is explicitly FAKE; tests verify UI-only behavior and no inference/engine mutation requests, not a real installation.
- Real Electron/Xvfb launch was attempted, but this OCI host reports `sandbox-unavailable` before its first window. No sandbox bypass was used. Updated real Electron and packaged-mac smoke assertions still require a supported host.

Mac acceptance should rebuild/package with the normal scripts, run packaged launch smoke and the separate public-update Mac gate documented in PUBLIC-UPDATER-MAC-GATE.md. No release was published by this integration task.
