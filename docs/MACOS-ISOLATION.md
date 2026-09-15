# macOS Apple Silicon AI isolation

## Status and integration contract

The AI adapter now has a **separate, fail-closed `darwin-seatbelt` backend**. Linux's bubblewrap namespace/mount/launcher path is retained. This document supersedes the macOS-unsupported statement in `AI-ADAPTERS.md`; its provider flags, exact reviewed versions, explicit authentication, schema/event validation and no-fallback contract still apply.

**This implementation was developed and regression-tested on Linux. It does not establish that a Mac runtime passes.** The Darwin-only tests assert actual success on Darwin arm64 and explicitly skip elsewhere; they never accept a failed runtime probe as a passing Mac test. Hosted Mac execution is a release gate, not a profile-construction claim. No authenticated inference, subscription, account entitlement, Developer ID signing or notarization was verified.

Public entry points remain `probeProviders(config)` and `runAnalysis(request)`. `ProviderProbe.isolation.backend` can now be `darwin-seatbelt`; `available` and `runtimeVerified` become true only after an actual adversarial runtime probe succeeds. Analysis metadata uses the same backend name. All existing limits and error normalization remain in place.

Optional **trusted, server-owned** configuration:

```ts
const config: AIConfig = {
  sandbox: {
    runtimeNodePath: "/absolute/private-install/official-node/bin/node",
  },
  providers: {
    codex: {
      executablePath: "/absolute/approved/native/codex",
      auth: { kind: "codex-auth-file", path: "/canonical/approved/auth.json" },
    },
  },
};
```

Paths above are examples, not discovered credentials. Never expose these configuration fields as arbitrary browser inputs. A backend **already running under the bundled standalone official Node sidecar** may omit `runtimeNodePath`. The probe explicitly refuses to assume Electron's `process.execPath` is Node; its child also checks `process.versions.electron`. Production Darwin runs execute the native CLI directly, so the Node sidecar is required for the isolation probe, not as an engine wrapper.

No Developer ID certificate, signing entitlement, administrator action, SIP change, quarantine removal, global security setting or privileged fallback is required by this code. Personal/ad-hoc Electron distribution is separate from OS confinement. A missing/deprecated/unsupported `/usr/bin/sandbox-exec`, incompatible loader or rejected profile yields an unavailable probe, never an unsandboxed engine.

## Files, executables and configuration

- Only Darwin **arm64** is implemented. Thin ARM64 `MH_EXECUTE` or a universal binary with exactly one ARM64 slice is accepted. Multiple ARM64/ARM64e alternatives are conservatively rejected so dyld cannot select an unchecked slice. Universal entries must have safe bounded offsets/sizes, valid alignment, no table or slice overlaps, and an exact ARM64 CPU subtype match between the table and executable header; load commands must fit inside that slice. ELF and JS/shell wrappers are not executed on Darwin.
- Both the executable's canonical path and **every intermediate symlink and target ancestor** are checked for ownership (root or the application UID) and non-group/world-writability. Root-owned sticky `/tmp` and `/private/tmp` are permissible ancestors, not data grants. Symlink loops and unsafe intermediate directories fail. Relative symlink targets retain literal components during inspection: `unsafe/../engine` cannot hide a writable directory, while trusted `../lib` installation links remain supported. Install native payloads/sidecars in a trusted private installation; group-writable installations and ancestors (including a group-writable Applications directory) can be rejected. This adapter never changes their permissions automatically.
- Native Mach-O load commands are read directly, without executing `otool`, npm, a shell or a wrapper. Non-system dylib dependencies, including `@rpath`/`@loader_path` dependencies, are rejected. This deliberately favors the standalone official Node distribution over dynamically linked Homebrew Node.
- Discovery checks exact project-owned native packages; exact `/opt/homebrew/lib/node_modules` and `/usr/local/lib/node_modules` platform package layouts (nested and hoisted); and known `.local/bin`, Homebrew-bin and `/usr/local/bin` entries. It does not search inherited PATH or enumerate a home. A recognized npm `@openai/codex/bin/codex.js` symlink is resolved to its native ARM64 platform payload **without evaluating JS or package metadata**. An explicitly configured path is not silently replaced by some unrelated installation.
- Version/flag/feature checks remain pinned to **Codex 0.154.0 / Claude Code 2.1.270**. A newer binary is unsupported until reviewed. On Darwin even version/help/features/empty-auth-status commands run under Seatbelt, with **no networking** and private HOME/cwd.
- Every admitted analysis gets a fresh mode-0700 canonical `/private/tmp/ai-…` root. Only separate `home`, `work`, `tmp`, `codex` and `claude` children are writable. The root itself is not writable/readable by the engine, except metadata required for cwd traversal. Source is passed on stdin, never mounted or staged on disk.
- The profile starts with `(deny default)`, imports no permissive system profile, allows execution/mapping of the exact native target, and makes that file read-only. System loader access is limited to `/usr/lib`, system Frameworks/PrivateFrameworks and system dyld. There is no `/Users`, `/Library`, `/usr`, host HOME, source checkout or general `/private/tmp` read grant. Ancestor metadata is not directory-content permission.
- Auth and schema are exact read-only files. Codex's minimized auth copy is installed in the private CODEX_HOME; explicit denies prevent modifying/unlinking it or renaming its containing scratch root. Scratch symlinks cannot turn a denied outside file into an allowed file. Scratch cannot supply executable dylibs or plugins.
- The environment is constructed, not inherited: no NODE_OPTIONS, DYLD injection settings, Electron flags, SSH agent, cloud/service tokens, ambient credentials, inherited proxies or custom API bases. PATH has no executable directory. The existing official no-tools/safe-mode/config-discovery controls are unchanged.

## Explicit authentication and managed policy

The existing private-file reader is unchanged: canonical absolute path, no symlinks, regular file, application UID, mode with no group/other permissions, and a 64-KiB cap. Credentials are not read until isolation has passed. Only known Codex auth fields are copied. API keys and an explicitly supplied official `claude setup-token` token use only the corresponding approved credential environment variable. Canonical credential files are never modified; read-only OAuth copies may require renewal outside the adapter.

There is **no** login flow, home credential discovery, Keychain scraping, password-store fallback or account/subscription inference. Mach services including Keychain, preferences daemons and arbitrary XPC helpers are denied by default.

Before Darwin CLI preflight or analysis, metadata-only checks retain the Unix managed paths and add exact known Mac paths:

- `/Library/Managed Preferences/com.openai.codex.plist` and the same domain in the current OS username's managed-preferences directory.
- `/Library/Managed Preferences/com.anthropic.claudecode.plist` and its per-user equivalent.
- `/Library/Application Support/ClaudeCode/managed-settings.json`, `managed-settings.d`, and `managed-mcp.json`.

Presence, symlink or metadata access failure blocks with `managed_policy_unsupported`. The adapter does not copy, parse, execute, hide-and-ignore or override those policies. Remote organization-policy compatibility and other delivery mechanisms still require organizational approval and an authorized provider test; these checks are not a claim of complete enterprise policy integration.

## Egress and process containment

Darwin has no Linux network/PID namespace. Its topology is intentionally different:

```text
native CLI [Seatbelt, no fork]
  -> single already-bound 127.0.0.1 TCP port
  -> host relay -> private Unix CONNECT proxy
  -> exact provider CONNECT authority / public pinned IPv4:443 only
```

The TCP relay is **outside** Seatbelt. This avoids granting the engine a listener, an arbitrary loopback range, or Unix-socket access merely to launch the Linux-style relay. Only `(remote tcp "127.0.0.1:PORT")` is allowed; no direct external connection, other loopback port, DNS, inbound listener, Unix socket or Mach networking service is granted. The host listener stays bound until the process completes, preventing port-allocation races. The existing Unix CONNECT proxy retains exact provider hostname/443 matching, host-side public-IP checks/pinning, byte/header/connection/idle bounds and end-to-end TLS. No wildcard domain or automatic egress expansion is introduced. The local endpoint is not a boundary against an already-compromised same-UID host process.

The proxy filters **CONNECT authority and the DNS-resolved public IP/port**, then forwards opaque TLS bytes. It does not independently prove that TLS SNI or the encrypted HTTP `Host`/`:authority` matches the CONNECT hostname; that correspondence and certificate validation are delegated to the trusted, pinned CLI's TLS/HTTP stack. An allowed shared IP is not proof of encrypted request authority. There is no TLS interception, custom CA, verification bypass or profile expansion to claim otherwise.

The real macOS `/etc/ssl/cert.pem` must canonicalize to `/private/etc/ssl/cert.pem`, be root-owned/non-writable and contain a parseable PEM CA bundle. Both SSL_CERT_FILE and NODE_EXTRA_CA_CERTS point to that exact file. No custom trust root or TLS-verification disable switch is added. A separate Darwin test performs only a verified TLS handshake with `api.openai.com` through the proxy; it sends no provider API request or credentials. That test requires live public TLS connectivity and is not an entitlement/inference test.

**Fork is denied**, while `process-exec` is scoped to the exact native target. Production does not start a shell/launcher inside the sandbox. The probe tests an attempted detached same-Node child and an arbitrary system executable: both must fail with a permission denial. This is deliberately stricter than trying to reap arbitrary escaped sessions. An official CLI that requires subprocesses for this reviewed no-tools operation fails rather than widening the profile. Ordinary process-group cancellation/deadline/cap handling is retained; there is no claim of a PID namespace. A Darwin timeout test observes the real sandboxed PID, times it out, and requires ESRCH afterward.

Mac scratch is ordinary private disk, **not Linux's size-limited tmpfs**. Hard deadlines and bounded streams do not provide CPU/memory/disk quotas. Deployment concurrency and storage/resource admission remain an integration responsibility. Root/kernel and a privileged or already-compromised same-UID host process are outside this boundary; temporary cleanup is not secure erasure.

## Actual runtime gate and tests

Latest local execution: **91 AI tests: 85 passed, 0 failed, 6 explicitly Darwin-only skips**. The complete project `tsc --noEmit` and owned-file `git diff --check` exited 0. The actual Linux probe still reports `backend: "linux-bwrap", available: false, runtimeVerified: false` with kernel namespace/loopback **EPERM**, rather than bypassing its boundary.

`probeMacSandbox` does not cache success. Its credential-free Node process must demonstrate all of:

1. Scratch read/write and expected private cwd/HOME, scrubbed injection/service environment, real CA file readability/parsing.
2. Read-only fake auth/schema; denied mutation/unlink/directory relocation; denied read/write of a real outside sentinel, denied arbitrary `/etc/passwd` read, and denied scratch-symlink escape.
3. Permission-denied direct outbound TCP, another **live** loopback listener, and a **live** outside Unix socket. A timeout or connection refusal is **not** counted as sandbox enforcement.
4. Successful connection to the one permitted proxy port, where an arbitrary CONNECT destination must be rejected by the real proxy.
5. Denied detached child creation/arbitrary child executable, not a fabricated PID-isolation claim.

On Darwin arm64 (with the official standalone Node sidecar and pinned native CLIs installed):

```sh
"/absolute/official-node/bin/node" --import tsx --test \
  tests/ai-macos.test.ts tests/ai-macos-runtime.test.ts
```

No opt-in success flag or mocked Darwin platform is used. These tests must fail on Darwin if the sandbox, pinned CLIs, TLS route or cleanup is broken. On Linux the six actual-Darwin tests explicitly skip; constructive tests and the real host TCP-to-Unix proxy-denial test run. Legacy Linux tests remain unedited and should continue to run on Linux. In particular `tests/ai-sandbox.test.ts` contains intentionally Linux-specific backend expectations; do not label running that suite on Mac a valid Mac acceptance test.

Release gates still outstanding from the Linux development host: actual hosted Mac test output, unsigned/ad-hoc desktop-plus-sidecar execution under the eventual app identity/install path, credential-free official CLI compatibility inside this exact profile, and separately authorized model/auth-mode inference plus organization-policy compatibility. Do not broaden file/network rules or weaken signing/system security to manufacture a passing test.

## References reviewed

- Apple App Sandbox documentation (distinguishes entitlement-based App Sandbox from this runtime Seatbelt profile): https://developer.apple.com/documentation/security/app-sandbox
- Apple XNU Mach-O definitions: https://raw.githubusercontent.com/apple-oss-distributions/xnu/main/EXTERNAL_HEADERS/mach-o/loader.h
- Pinned Codex Seatbelt entry and network generation: https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/sandboxing/src/seatbelt.rs
- Pinned SBPL base and minimal platform permissions (reviewed, **not imported wholesale**): https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/sandboxing/src/seatbelt_base_policy.sbpl and https://raw.githubusercontent.com/openai/codex/rust-v0.154.0/codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl
- Official installed Codex 0.154.0 npm wrapper/package and Claude 2.1.270 package layouts were read without executing installation hooks.
- OpenAI MDM domains/requirements: https://developers.openai.com/codex/enterprise/managed-configuration
- Anthropic managed settings paths/domain: https://code.claude.com/docs/en/managed-settings
- Existing pinned safety/auth sources remain listed in `AI-ADAPTERS.md`.
