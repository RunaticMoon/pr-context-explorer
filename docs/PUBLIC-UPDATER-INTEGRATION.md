# Public updater desktop integration

The original integration checks below were recorded in September 2026. Current release acceptance uses both Mac15 and Mac26 runners; CI results and interactive user-machine checks remain separate.

## Main/renderer contract

- `prceDesktop.status()` retains the legacy `updates` field and adds `publicUpdates: {enabled, channel, reason?, phase, version?, received?, total?, errorCode?, lastChecked?}`. Installed version and exact boolean preferences are top-level fields.
- Finite preload methods: `checkUpdate()`, `downloadUpdate()`, `cancelUpdate()`, `installUpdate()`, `updatePreferences(autoCheck, autoDownload)`. There is no general invoke/send, renderer URL, path, credential, target-version or busy-state input.
- Both IPC handlers require the owned WebContents, its actual main frame and the fixed loopback root document. SPA query navigation is permitted; foreign origin/path, subframes, other windows and extra command fields are rejected.
- Public personal builds default on at compile time (`PRCE_PUBLIC_UPDATES=0` disables). Runtime requires packaged Darwin arm64 and a non-signed build. Signed private updates remain a separate native-only channel. Development/browser contexts do not contact the updater network.
- Preferences default to automatic checks enabled and automatic downloads disabled. First check is deferred 30 seconds after readiness; subsequent checks use one six-hour timer. Downloaded/preparing/ready updates are preserved by both periodic and manual checks. Enabling automatic checks schedules a check immediately; enabling automatic download fetches an already discovered update immediately. Disabling checks cancels the pending timer. Backend/renderer failure stops scheduling. No automatic action installs an update.

## Worktrail-style update experience (0.9.0)

- App menu **업데이트 확인…** and **업데이트 설정…**, plus the desktop header update entry, lead to the existing update settings. The fixed preload `onOpenUpdates` subscription never forwards Electron events or arbitrary payloads.
- One renderer status subscription serves the settings and a nonmodal notice while reading a PR. A new version offers settings/download; a downloaded version offers the install/restart entry. Dismissing an available-version notice does not suppress the later downloaded notice. No background navigation, download without opt-in, or install without native consent occurs.
- Opening update settings preserves the PR's query selection; returning uses the existing workspace/reader restoration. The UI shows installed version, candidate version, last check, progress and bounded failure guidance.
- Like Worktrail, default automatic checks are enabled, automatic downloads are opt-in, and installation/restart is explicit. PRCE retains its existing six-hour interval and Electron replacement/rollback mechanism. Worktrail's Sparkle Ed25519 feed signing is **not** used here: PRCE trusts its fixed public GitHub HTTPS repository and validates manifest hashes, archive contents and the ad-hoc app signature. These are not independent publisher signatures or Apple notarization.
- Existing public-updater builds (including 0.8.1) can discover 0.9.0 through the unchanged `public-mac.json` contract. Legacy builds lacking this channel need one manual installation.

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
