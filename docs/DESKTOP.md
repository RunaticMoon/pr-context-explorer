# Apple Silicon desktop

PR Context Explorer 0.4.0 is packaged as an Electron application with its **actual web UI, compiled local backend, prompt resources, AST parser and standalone Node runtime**. It does not need a source checkout, `tsx`, a globally installed Node, or a target project's dependencies after installation.

## Default: personal app, no Apple Developer membership

The default macOS build is **ad-hoc signed**, not Developer ID signed or notarized. It needs no Apple Developer certificate. It retains Electron's renderer sandbox, isolated preload, disabled Node integration and sealed application archive. Ad-hoc signing does **not** establish publisher identity or make Gatekeeper trust the download. Use macOS's normal, explicit approval flow when applicable; these scripts never remove quarantine, disable Gatekeeper or fabricate a certificate.

Update this personal build using the separate authenticated manager in [`distribution/prce`](../distribution/prce), documented in [MACOS-RELEASE.md](MACOS-RELEASE.md). The root package exposes `prce` as a private Git-installable npm bin; the repository/package stays private and is not published to npm. The manager requires Python 3 and `gh` and uses the user's own GitHub authentication. Its optional LaunchAgent is opt-in. In-app Squirrel installation is deliberately unavailable on personal builds.

The application menu provides:
- **Preferences and Update Status…**: version, stable channel, external/signed mode, progress and safe errors.
- **External Update Manager…**: manager instructions, without executing a helper or passing it credentials.
- **Quit for External Update…**: explicit quit confirmation, then active-work cancellation confirmation if needed. It does not force installation or discard saved analysis.
- **Dependency Diagnostics…**: bounded argument-array checks, no login shell or automatic package installation.

Install destination: `~/Applications/PR Context Explorer.app` (no admin requirement). See the release guide for authenticated `prce install`, `prce check`, `prce update` and `prce auto-update` commands.

## Build and run

Use Node 24 and npm on an Apple Silicon Mac; Git is required for the app-owned demo fixture and source collection. Install Git using Apple's Command Line Tools or Homebrew yourself if absent.

```sh
npm ci
npm run test:desktop
npm run desktop:pack:mac      # .app directory
npm run desktop:dist:mac      # DMG + update ZIP, never publishes
```

Output contract:

```text
release/mac-arm64/PR Context Explorer.app
release/PR-Context-Explorer-0.4.0-arm64.dmg
release/PR-Context-Explorer-0.4.0-arm64.zip
release/latest-mac.yml       # builder metadata; not authorization to use Squirrel
```

`desktop:build` type-checks the application and desktop code, builds Vite without auto-loading `.env`/Vite config or exposing environment variables, and produces `desktop/build/app` and `desktop/build/runtime`. It does not download Node. The packaging commands then obtain the version-pinned official Node archive and compare its SHA-256 against a checked-in digest before extracting only `bin/node` and `LICENSE`.

For a development window:

```sh
npm run desktop:dev
```

`desktop:prepare` explicitly installs the pinned Electron binary (also works where npm lifecycle scripts were disabled), builds the app and stages the checksum-verified **host-platform** Node. `desktop:dev` then launches that staged app. There is no fallback to `process.execPath` as a Node interpreter in Electron.

On Linux, `desktop:pack:mac` can produce a structurally inspectable arm64 `.app`, but cannot perform Apple's ad-hoc signing or prove that macOS launches it. Rebuild on macOS for an installable personal artifact. DMG creation and macOS runtime verification belong on a real Mac/hosted macOS runner.

## Runtime and trust boundaries

- App ID: `com.runaticmoon.pr-context-explorer`; product name: `PR Context Explorer`; minimum declared macOS: 13; arm64 only.
- The backend binds `127.0.0.1` on an OS-selected ephemeral port. A random main-to-backend capability is added only by the dedicated Electron network session. It is never exposed through preload or stored in browser storage. Requests still require the original exact Host/Origin, session cookie and mutation CSRF controls. A normal browser cannot access this app-owned backend just by knowing its port.
- Preload exposes only `prceDesktop.status()` with no arguments. Main validates the actual webContents, exact main frame and root URL. No renderer IPC selects paths, opens URLs, launches helpers, imports credentials, saves preferences, downloads or installs updates. Those operations use native menus/dialogs exclusively.
- New windows, external navigation, redirects, webviews, downloads and permission requests are denied. Renderer Node integration is off, context isolation and sandbox are on. Packaged development tools are disabled.
- Electron fuses disable RunAsNode, `NODE_OPTIONS` and Node CLI inspection; embedded asar integrity and OnlyLoadAppFromAsar are enabled. Backend/resources live outside asar because the standalone Node/AI subprocesses require real filesystem resources. macOS signing seals the whole bundle; do not place writable caches or user settings there.
- Backend modules are compiled as an ESM tree, preserving `import.meta.url` and trusted dynamic imports. The actual TypeScript AST library is a runtime dependency, not a TypeScript source loader. Both `launcher.cjs` and prompt files are packaged. Adapter fingerprints include the compiled app-owned modules.
- The backend has an explicit environment allowlist, fixed app-owned HOME/temp/config/cache directories and explicit Homebrew/system PATH entries. No publisher `GH_TOKEN`, user `NODE_OPTIONS`, arbitrary PATH or ambient AI configuration is inherited. AI isolation remains the separate fail-closed gate described in [MACOS-ISOLATION.md](MACOS-ISOLATION.md).
- Single-instance locking occurs before backend startup. Normal quit and OS termination cancel jobs and shut down the sidecar; a bounded fallback reaps its process group. Parent IPC disconnect also cancels backend work. The AI runner handles its own detached groups when cancellation arrives. A machine crash cannot guarantee cleanup; an old marker is not proof of a live process.

## User data and explicit source authentication

Everything mutable belongs under:

```text
~/Library/Application Support/PR Context Explorer/
  preferences.json          # validated native-menu booleans, no token
  release-credential.enc    # optional signed-updater credential, encrypted by safeStorage
  desktop-runtime.json      # main/sidecar process marker, not a control socket
  ai-config.json            # optional explicit owner-provided private AI settings
  home/                     # dedicated source-CLI HOME; not the user's whole home
  tmp/
  demo/fixture/             # app-owned Git fixture; never target code execution
  live/                     # original private store/cache
```

The app does **not** silently borrow source credentials from a login shell or the update manager. If you choose GitHub CLI authentication for Live source connections, authenticate the dedicated source HOME explicitly, for example:

```sh
HOME="$HOME/Library/Application Support/PR Context Explorer/home" /opt/homebrew/bin/gh auth login --hostname github.com
```

This is a user-run setup command, not something the renderer executes. Select `gh` authentication in the normal Live connection UI. GitHub Enterprise uses its exact registered hostname. The external update manager's login remains separate in your usual user HOME. Ambient shell-token authentication is intentionally unavailable in a Finder-launched backend; do not put the publishing token in either source store.

Owner-provided AI settings must be the fixed `ai-config.json` above, owned and mode 0600; settings are not copied from target projects. Use explicit approved engine/auth paths documented by the AI adapter. Code collection remains read-only: no target installation, tests or scripts are run.

## Optional Developer ID in-app updates

This path is **not required for personal installation**. Enable only when the owner later has real Apple Developer ID and notarization credentials:

- Set `PRCE_RELEASE_SIGNED=1` and `PRCE_APPLE_TEAM_ID` to the real ten-character team ID while building. Supply the certificate/password and notarization authentication through protected release-job environment/secrets, never application files.
- The builder requires code signing, enables hardened runtime and notarization, and signs the Node sidecar. A missing certificate must fail rather than produce a pretend signed release.
- The app additionally verifies the installed bundle with `codesign --verify --deep --strict` and checks Developer ID authority, exact app ID, TeamIdentifier and hardened-runtime metadata. A default, unpackaged, ad-hoc, wrong-team or invalid bundle remains in external-update mode.
- Native credential selection accepts only a private, owned, bounded, nonsymlink fine-grained token file. Grant **Contents: read-only**, limited to the private `RunaticMoon/pr-context-explorer` repository. The app verifies GitHub account/repository identity and asks before saving. GitHub identity verification does not independently prove the token's complete permission set; create it with the documented least privileges.
- `safeStorage` must support OS encryption; no plaintext fallback. The encrypted token is main-only, never a renderer/browser setting or backend variable. Cancelling the dialog stores nothing; Forget removes the app's saved token.
- The pinned official `electron-updater` private GitHub provider is explicitly configured for stable releases. It does not discover a publisher token from app configuration. Every HTTP request, including redirected asset requests, passes a strict HTTPS destination policy. Only this repository's GitHub release API can receive Authorization; GitHub asset CDN requests have Authorization/Cookie stripped, and other hosts are denied. The app pins an internal executor injection, so provider/executor upgrades require re-review.
- Downgrades/prereleases are disabled. Auto-check is at startup after 30 seconds and every six hours; no unbounded retry loop. Automatic download is opt-in. Progress/errors are safe summaries with logging disabled. Installation needs a downloaded update, an idle backend and explicit restart consent; concurrent consent cannot install twice. `autoInstallOnAppQuit` is false. Native Squirrel signature verification is not bypassed.

## Verification and honest limits

Local Linux arm64 verification performed:
- `npm run test:desktop`: **14 desktop tests** plus a compiled-runtime integration test passed. The integration copies the complete runtime to a separate temporary directory, so ancestor checkout `node_modules` cannot mask a missing dependency. It serves the real web UI/demo, imports the real AI module and shuts down via IPC.
- The same relocated integration passed using the checksum-verified standalone **Node 24.21.0 linux-arm64** sidecar.
- `npm run desktop:pack:mac` passed on Linux; `tests/e2e/desktop-package.mjs` verified actual Mach-O arm64 Electron/Node binaries, bundled runtime/prompts/license, minimal asar, integrity metadata and security fuses. This is structural evidence, not macOS launch evidence.
- Existing browser regression: **12 tests passed**. Full repository test execution at the integration checkpoint: **306 passed, 6 actual-Darwin tests skipped**, no failures; other agents may add tests afterward.
- A real Linux Electron smoke was attempted under Xvfb with `chromiumSandbox: true`. Chromium aborted because this host's SUID sandbox helper is not configured. The app was **not** rerun with `--no-sandbox`, and a secure Electron window is not claimed to have passed here.

On a real Apple Silicon test account, run:

```sh
npm run desktop:prepare
npm run desktop:smoke                  # real sandboxed Electron + compiled runtime
npm run desktop:pack:mac
node --test tests/e2e/desktop-package.mjs
npm run desktop:smoke:packaged         # actual sealed .app, dedicated idle CI account
npm run desktop:dist:mac
```

The packaged smoke uses Chromium CDP only for testing, not disabled Node-inspection fuses; it verifies the real renderer, external-update status, capability denial, process marker and sidecar exit. It is explicitly skipped on Linux. Do not run it against an active user's installation/data. Real macOS launch/ad-hoc signing/DMG, external-manager installation/update and any future Developer ID/Squirrel update must be reported from actual Mac execution separately.

### External-manager process contract

`desktop-runtime.json` is mode 0600 with `{pid, backendPid?, executable, appPath, version, startedAt}`; `backendPid` appears after startup. The app removes it after orderly backend shutdown. The manager must independently inspect executable/app paths and fail closed on uncertainty: absent marker is not proof of stopped, and stale PID is not proof of running. There is no renderer-to-manager execution channel. Helper implementation/release workflow ownership remains under `distribution/**` and `.github/workflows/**`.

### Dependency provenance

Pinned Electron **44.3.0** was verified against the official Electron release; electron-builder **26.16.1** against its official release metadata; electron-updater **6.8.9** and esbuild **0.28.2** against installed/npm metadata. Node **24.21.0** SHA-256 pins come from official `nodejs.org/dist/v24.21.0/SHASUMS256.txt`. App dependency notices are in `THIRD-PARTY-NOTICES.txt` inside asar; Electron retains its framework notices, and Node's full license/provenance ship in `Contents/Resources/node/`. Builds do not publish anything.
