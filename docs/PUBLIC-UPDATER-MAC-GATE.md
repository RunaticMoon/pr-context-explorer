# Final-ZIP macOS public updater acceptance gate

## Required invocation

Run on a **dedicated, disposable macOS arm64 CI account with a GUI login session**, after generating and verifying the public manifest. The account must have no PR Context Explorer process or existing `~/Library/Application Support/PR Context Explorer` directory. Existing data is a hard failure, never deleted to make the test pass.

```sh
export CI=true
export PRCE_PUBLIC_UPDATE_CI=1
export PRCE_PUBLIC_UPDATE_ZIP="$GITHUB_WORKSPACE/release/PR-Context-Explorer-0.6.0-arm64.zip"
export PRCE_PUBLIC_UPDATE_MANIFEST="$GITHUB_WORKSPACE/release/public-mac.json"
export PRCE_PUBLIC_UPDATE_OLD_VERSION=0.5.99
npm run test:public-update:mac
```

Use the actual release version in the ZIP filename. The old fixture version is deliberately explicit, must be a stable numeric version, and must be lower than the manifest version. It is **not a claim that this old version was ever released**. No test tags, release records, GitHub writes, credentials, remote model accounts, or network discovery feeds are used.

The command is `node --import tsx --test tests/e2e/public-update-mac.mjs`. It fails on unsupported OS/architecture, missing inputs, missing packaged resources, or any incomplete handshake. There is no `skip`, “success or unavailable”, or mocked macOS fallback in the explicit gate. Ordinary cross-platform contract tests can skip their unsupported-host assertion when already running on macOS arm64.

Both macOS CI jobs must supply these variables. The macOS 26 job must download **the same final ZIP and public manifest accepted by the macOS 15 build job**, not rebuild the release. The gate checks the ZIP's manifest size, SHA-256, canonical asset name, and version before testing, and checks its SHA-256 again afterward. Keep the publish job dependent on both gate successes. Do not upload the temporary fixture directory as a release asset.

## What actually executes

1. Reuse `desktop-package-isolation.mjs` to extract the final distributable outside the checkout and any ancestor `node_modules`. Verify its original deep/strict signature and the production bundle/runtime contract. The existing install helper uses Python in the **CI driver**, not in the installed updater.
2. Run the packaged signed native ACL executable through the production path checks against a real permissive macOS ACL; require denial, remove the test ACL, and require acceptance.
3. Clone the extracted app into an explicitly labeled `CI-ONLY-FIXTURES-DO-NOT-PUBLISH` directory. Change only the old fixture's Info.plist and ASAR package version, install a CI-only observation/quit wrapper around its unchanged production main, update ASAR integrity metadata, and ad-hoc sign the modified fixture. The target release ZIP and target app are never modified or re-signed.
4. Launch the **actual old packaged Electron executable**. Require a visible, loaded localhost window and its real `app.getVersion()`, PID, and user-data path. The wrapper observes the actual production window; it does not create boot, readiness, commit, or result receipts.
5. A trusted test driver stages the local ZIP with the **production bounded ZIP extractor and app validator**, writes a validated production install plan using the actual old app's PID/start identity, and copies the old app's bundled Node, bundled updater worker, and signed native ACL executable into a private adjacent work directory. This intentionally bypasses public discovery/download and the host `PublicUpdater.prepareInstall()` orchestration; it does not inject test options into any shipped API.
6. Launch the **packaged worker using the packaged Node executable** with a scrubbed environment, private cwd, and real IPC. Require the actual nonce-bearing helper-ready response. Verify the old app is still alive, its bundle unchanged, and no replacement launch has occurred. Ask the old fixture to quit through real Electron `app.quit()`; the worker must observe real process exit.
7. Positive case: require the production transaction's `installed` result, actual new-main `boot.json` and `startup.json`, helper `commit.json`, matching nonce/version/PID/start identity, a live new main process, and a zero worker exit. Compare every installed resource/signature byte, path, symlink target, and executable flag to the original extracted final bundle. Extraction's intentionally restricted read/write modes are not mistaken for resource mutations.
8. Rollback case: create a **separately labeled, ad-hoc signed target fixture** of the manifest version with an intentionally failing packaged backend entry. It passes production structural/signature validation but must fail real startup after early boot registration. Require the worker's nonzero failed-install exit, `rolled-back` result, absent commit, dead failed-new PID, restored old bundle digest, and a newly started old Electron process with a real visible loaded window. An `open` command returning zero alone cannot pass rollback acceptance.
9. Require a user-data sentinel to survive both transactions and require both update locks to be released. Cleanup signals only captured or path-and-start-identity-verified fixture processes, verifies the created data directory's inode/device, and removes only test-owned paths. Failures retain the private fixture work directory for local diagnosis; never publish its ZIPs or manifests.

Only after both cases and cleanup pass does stdout contain `PUBLIC_UPDATE_MAC_ACCEPTANCE` followed by JSON evidence, including the final ZIP hash, explicit old/new versions, actual process IDs, nonces, worker exits, and native ACL denial. The node:test case has a ten-minute bound. Each process/receipt wait is also bounded; production helper timeouts are not lowered or bypassed.

## Scope and remaining evidence

This is a local-artifact replacement/startup/rollback acceptance gate, not a public GitHub transport test. Public discovery, TLS, download hashes, archive attacks, cancellation, and host analysis-admission/busy orchestration require their separate core/host tests. The gate never publishes dummy releases to exercise those paths.

It also does not assert that the old fixture represents compatibility with an older released codebase: it is the same release code under an explicitly lower fixture version. The successful target **is** the exact release artifact. The rollback target is explicitly damaged fixture code, never the release artifact.

Cross-platform checks verify configuration rejection, explicit unsupported-platform failure, and the bundle comparison's sensitivity to resource/signature/executable/link changes. They are not a substitute for macOS execution. Initial implementation was validated on Linux only; real macOS 15 and 26 acceptance remains pending until those CI jobs execute this command successfully.
