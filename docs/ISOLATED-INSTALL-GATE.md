# Isolated distributable installation gate

A `.app` under `release/mac-arm64` is **not** an installation test. Node walks ancestor `node_modules` directories; a missing `Resources/runtime/node_modules/typescript` can be silently satisfied by the checkout. The packaged smoke now accepts only the final ZIP and launches its extracted application outside the checkout.

## Required macOS gate

On a fresh, dedicated Apple Silicon macOS CI account with a GUI session, Python 3 at `/usr/bin/python3`, dependencies installed and Apple's command-line tools available:

```sh
npm run desktop:dist:mac
PRCE_PACKAGED_CI=1 npm run desktop:smoke:packaged
```

The default artifact is `release/PR-Context-Explorer-${package.json.version}-arm64.zip`. To test another final ZIP from the same expected application version:

```sh
PRCE_PACKAGED_CI=1 PRCE_DESKTOP_ZIP=/absolute/path/to/artifact.zip npm run desktop:smoke:packaged
```

`PRCE_DESKTOP_APP` is rejected. CI must build **distribution artifacts**, not `desktop:pack:mac` (`--dir`). Run the gate before upload/publish, on the exact ZIP being published. Root scripts/workflow integration is intentionally a separate change; the existing `desktop:smoke:packaged` command already selects the updated launch file. Run `npx tsx --test tests/desktop-isolated-package.test.ts` as a portable regression prerequisite (also picked up by `npm test` and the existing `test:desktop` glob).

## What is required to pass

- A new real temporary installation directory, with realpath ancestry checked outside the checkout. Any ancestor `node_modules`, including `/tmp/node_modules` or `/node_modules`, fails closed, even if empty or a symlink. Nothing is removed to make this pass.
- ZIP size below 2 GiB and extraction using `distribution/prce`'s production installer routine: bounded entries/uncompressed size, safe paths, no special entries, no traversal, no escaping symlinks or writes through links. Destination must be new. No dependency copying or bundle repair after extraction.
- `codesign --verify --deep --strict` on the extracted app; native ACL helper signature, arm64 architecture, executable permissions and system-library-only linkage remain asserted. Ad-hoc signature validity does **not** imply Developer ID, notarization or Gatekeeper approval.
- The **bundled Node** resolves baseline runtime packages plus the declared transitive dependency closure to real paths inside the installed runtime, and dynamically imports the actual `desktop/backend.js` before GUI launch. This is not the checkout Node probing checkout files.
- The real sealed app starts with outside-checkout CWD and clean HOME/environment, without `NODE_PATH`, `NODE_OPTIONS`, developer PATH or packaged test-data overrides. The Playwright driver may live in the checkout; the application and backend do not.
- Normal app status IPC, dynamic expected version, arm64, external update policy, demo rendering, no renderer `require`, unauthenticated HTTP rejection, owned runtime lease, exit code zero on normal SIGTERM, lease removal and backend exit remain required.
- Failure cleanup is bounded and targets the owned app and identity-checked backend process groups, never a broad app/process-name kill. Generated installation directories are identity-checked before removal.

## User data safety

`PRCE_PACKAGED_CI=1` explicitly acknowledges the dedicated-account prerequisite; it is not an application setting. Before launch, the test refuses any existing app data in either the clean HOME or the actual account home obtained from the OS account database. Electron can choose account-based appData despite HOME. The test does not delete, rename or replace existing user data, does not set a packaged application data override, and does not touch source-checkout state. Generated data under the isolated temporary HOME is removed with that owned directory; if Electron uses the real CI account directory, generated data is left there. Provision a fresh ephemeral account/runner for each run, rather than deleting a default real-user store to rerun this gate.

## Portable regression evidence and limits

The permanent regression deliberately creates an incomplete fixture under the checkout, imports the **real installed TypeScript** successfully through ancestor resolution, copies only that incomplete fixture outside the checkout, then requires an actual Node `ERR_MODULE_NOT_FOUND`. A separate fixture imports a complete real dependency closure, rejects missing TypeScript, and rejects a symlink back to developer dependencies. ZIP traversal and non-ZIP/build-directory inputs are also rejected.

During implementation on Ubuntu, the actual published v0.4.0 ZIP (`artifacts/released-v0.4.0.zip`) was extracted through this helper outside the checkout and its runtime closure was rejected for missing TypeScript using the **host Node**. This is real artifact regression evidence, not a native macOS launch. Portable fixture passes and Linux skips do not establish macOS compatibility. Apple Silicon GUI, signature/native helper behavior, corrected ZIP success and macOS 26 compatibility must still be exercised on macOS; do not describe skipped tests as a passed install gate.
