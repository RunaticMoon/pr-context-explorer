# macOS system-configuration reads

## Evidence and scope

Run `34936979728`, job log `artifacts/github-job-104276926739.log`, proves two separate startup failures after the literal-root loader fix:

- Node 24.20.0 exits 1 with OpenSSL `fopen(/System/Library/OpenSSL//openssl.cnf)` / `Operation not permitted` (line 976; actual confinement also fails at line 1017).
- Codex 0.154.0 `features list` exits 1 because bootstrap cannot read `/etc/codex/requirements.toml` (`os error 1`, line 1021). Version/help success does not exercise configuration bootstrap.

These original errors **did not establish whether the host files exist**. The later metadata run `34944208393` observed a root-owned mode-0644 regular `/System/Library/OpenSSL/openssl.cnf`. The initial absence-only guard was incompatible with that stock host policy; [trusted OpenSSL support](MACOS-TRUSTED-OPENSSL.md) now preserves it without changing the profile. This is not evidence of recovered Darwin execution. Linux unit tests cannot establish Seatbelt's canonicalization or missing-path behavior. Claude help SIGKILL is separate and no permission is added for it.

## Source review

- [Node v24.20.0 `src/node.cc`, lines 1195–1251](https://github.com/nodejs/node/blob/v24.20.0/src/node.cc#L1195-L1251) loads the default OpenSSL configuration, uses `CONF_MFLAGS_IGNORE_MISSING_FILE`, and reports configuration errors. Absence is supported; EPERM is not absence. The environment and argv are **not** changed to disable configuration.
- [OpenSSL configuration documentation](https://docs.openssl.org/3.5/man5/config/) documents `.include`, provider modules and engine loading. The exact root-owned, non-writable, ACL-safe OS configuration is now explicitly trusted host crypto policy, not a reviewed no-code/no-secret dependency. There is no ad hoc TOML/INI parser, comment-only exception, include following, provider loading or `/dev/null` replacement here.
- [Codex rust-v0.154.0 loader](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/loader/mod.rs#L693-L747) reads the exact requirements file and treats **only** `NotFound` as no layer. The same file defines `/etc/codex/config.toml` and distinguishes NotFound from other read failures for the system config layer.
- [Pinned legacy loader](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/config/src/loader/layer_io.rs) defines `/etc/codex/managed_config.toml`. All three bootstrap leaves are covered, not merely the first failing lookup. In this release the loader moved out of `core/src/config_loader`; that older URL is 404 for this tag.
- [Official managed configuration documentation](https://developers.openai.com/codex/enterprise/managed-configuration) describes requirements, managed defaults, MDM and cloud policy. Requirements may contain managed hooks, so they must not be treated as harmless informational text. This patch does not override requirements, force conflicting features through them, or change cloud-policy handling.

## Exact additive profile delta

Six SBPL rules are added. They allow only `file-read-data` and `file-read-metadata` for these exact file names:

| Literal leaf | Purpose |
| --- | --- |
| `/System/Library/OpenSSL/openssl.cnf` | Preserve trusted OS crypto policy, or observe genuine absence |
| `/etc/codex/requirements.toml` and `/private/etc/codex/requirements.toml` | Codex requirements absence |
| `/etc/codex/managed_config.toml` and `/private/etc/codex/managed_config.toml` | Legacy managed-policy absence |
| `/etc/codex/config.toml` and `/private/etc/codex/config.toml` | System defaults absence |

Additional **metadata-only literal** ancestors: `/System`, `/System/Library`, `/System/Library/OpenSSL`, `/etc`, `/private/etc`, `/etc/codex`, `/private/etc/codex`. Existing root/private metadata rules remain unchanged. No directory-data read, `subpath`, prefix, wildcard, xattr read, executable mapping or write grant is added for these paths. `/etc/passwd`, sibling configs, policy includes, skills, plugins and secrets remain denied. No network, Mach, fork, JIT, root-rule or loader-tree relaxation is made.

The reported double slash is preserved in the evidence and exercised explicitly in the Darwin regression. The profile uses the canonical literal; it does not add a regex accepting path spellings.

## Host-side refusal before launch

`runSeatbeltCommand` now checks policies in its own prerequisites, before credential copying or native execution. This supplements, not replaces, the existing provider/auth guards:

1. `managedPolicyPresent([...MANAGED_PATHS.codex, ...MANAGED_PATHS.claude])` checks existing exact system and global/per-user MDM locations by metadata. Any present file (even empty), directory, dangling link, unreadable path or non-ENOENT error refuses with `managed_policy_unsupported`. Both sets are checked because this low-level API launches Node and either provider without a provider discriminator.
2. `validateMacSystemPolicyReads()` checks the fixed canonical system ancestors, including `/`. They must be root-owned directories without group/other write bits; no generic current-user ownership or temporary-root exception is used. `/etc` must be the root-owned symlink whose literal target is `private/etc` or `/private/etc`. Every target ancestor is checked, not merely final realpath. Other symlinked parents are refused.
3. ENOENT at an optional OpenSSL/Codex directory or exact leaf remains supported. A present OpenSSL leaf is accepted only as a root-owned regular file without group/other write bits and with a completely inspected absent or deny-only native ACL. Symlinks, special files, unsafe modes/owners, ACL grants and unknown results block. Codex leaves remain strictly absence-only, including empty regular files. No config contents are read or logged by preflight.

This supports only the fixed trusted OS OpenSSL configuration, not present AI managed configuration. Never delete, empty, copy, parse around, ignore or disable either policy. OpenSSL includes/providers/extensions remain limited to the original profile's allowed files and executable mappings; unsupported dependencies fail closed without new grants.

The validation is repeated per launch, not cached. Root/admin-controlled filesystem mutation during a running invocation is outside the existing trusted-system boundary; this is not an atomic snapshot against a malicious root administrator (nor are the existing system dylib reads). Unprivileged users must not be able to substitute the validated ancestors.

**Diagnostic callers that build an SBPL string and spawn directly must run the same preflight before execution, or use `runSeatbeltCommand`. Profile construction alone is not authorization.** This task does not modify the concurrently owned diagnostic script. Metadata reports should include the exact leaves, `/etc` symlink target and canonical ancestors, and preserve ENOENT versus EPERM/EACCES without printing policy content.

## Regression freeze and verification

`tests/ai-macos.test.ts` asserts each of the six exact new rules occurs once. Removing only these rules and the already-reviewed literal-root rule must still produce the unchanged pre-root SHA-256:

`6d018c27a3d192de5e65a5c6a3d0701245e781100c7180ad677f08b7534e4d1a`

The complete new profile for the same fixed test inputs is also frozen, including rule order:

`665326db0be538eb6f1fde765c675c60546814c5f5cfffb3d283d1edf5b09e05`

`tests/ai-macos-system-policy.test.ts` models metadata only (no config-content reader exists in its injected interface), covering genuine missing and empty directories; present/empty/unreadable leaves; file/directory/dangling symlinks; unexpected aliases; root/current-user ownership; writable ancestors; EPERM, EACCES, EIO, ENOTDIR and ELOOP. System metadata fixtures are synthetic and are not Mac evidence.

The original `tests/ai-macos-runtime.test.ts` added an actual-Darwin Node test requiring ENOENT for both reads and metadata of every absent config spelling, including the OpenSSL double slash and both etc aliases. It simultaneously requires permission-denial errors for parent enumeration and passwd, and verifies no OpenSSL suppression/module environment variables. Existing actual Node confinement, TLS, PID timeout and pinned CLI capability tests remain mandatory on Darwin. All Darwin cases explicitly skip on Linux.

Local validation: targeted macOS tests pass on Linux (115 passed, 8 Darwin skips); full `npm test` passes (445 passed, 8 Darwin skips). TypeScript and `git diff --check` pass. Counts reflect this shared worktree at verification time, including concurrent diagnostic changes. **Next Mac execution remains required** to prove Node startup, canonical metadata behavior and Codex bootstrap/capabilities. No inference, credentials, remote CI run, commit or push is performed by this task.
