# Present system-policy preflight: metadata-only attribution

## What is actually established

The retained evidence is `artifacts/github-job-104295613524.log`, from Mac run
`34942949756`, job `104295613524`, at baseline `840d868`:

- Lines 193–213 show the native arm64 ACL helper build and the real
  `tests/ai-macos-acl.test.ts` execution: **5 passed, 0 failed, 2 skipped**.
  Line 204 is the actual Darwin fixture success (absent, deny, allow, inherited,
  hidden ACL and symlink cases). These are not Linux shim results or `ls` output.
- Lines 214–220 show `--startup-help-only=claude`, the Darwin arm64 host record,
  then `fatal` / `managed_policy_unsupported`, exiting 1. There is no Claude
  discovery/startup record or target PID. This stop is **host preflight**, not a
  newly observed Claude SIGKILL.
- `src/server/ai/macos.ts:26–88` puts the root-owned ancestor mode/ACL checks
  before the absence-only leaves. Reaching `managed_policy_unsupported` implies
  the preceding native ancestor checks succeeded on this run; it does not prove
  which optional directory or leaf was reached. In particular, it is not full
  Mac sandbox/confinement acceptance.

**The old log does not identify the leaf.** `/System/Library/OpenSSL/openssl.cnf`
is the first candidate in guard order, not a confirmed finding. A present leaf
and an unknown `lstat` error both produce the same original error. No real Mac
metadata capture was performed for this change; the available execution host is
Linux and no remote/CI operation was requested.

## Small next Mac capture (no full CI or target launch)

On the same real Darwin arm64 checkout, with dependencies and the already-built
native ACL helper present, run only:

```sh
node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --system-policy-metadata-only
```

If that checkout lacks the helper, its existing build command is
`node scripts/build-macos-acl.mjs` on the Mac build host. Do not rebuild the whole
runtime merely to collect this metadata. The guard still runs its existing
bounded native ACL helper; “no target launch” does not mean no ACL helper child.
No Node probe, Claude/Codex target, executable discovery, scratch allocation,
A/B dispatch, crash collection, auth or inference follows this mode, even when
the guard succeeds. A block still exits 1 through the existing `fatal` handler.
The metadata-only host record omits the account-bearing Node executable path.

The two new exact diagnostic tags are:

- **`system-policy-metadata`**: emitted from the guard's own `lstat` operation
  before its result/error reaches the original guard. Fields are a fixed-enum
  `path`, `exists: true | false | "unknown"`, and, only on success, numeric `uid`,
  octal permission `mode`, and `fileType: directory | regular | symlink | other`.
  `false` means `ENOENT`; all other metadata errors are `unknown` with no raw
  exception/code/message. These observations are not an ACL verdict.
- **`system-policy-preflight-blocked`**: includes the fixed source
  `validateMacSystemPolicyReads`, allowlisted error code, and
  `lastInspectedPath`. The exact original thrown object is rethrown, not replaced
  with a diagnostic error. For `managed_policy_unsupported`, the immediately
  preceding leaf observation identifies the blocking leaf and whether it was
  present or unknown. For an ancestor/alias failure, `lastInspectedPath` means
  only the most recent `lstat`, not an assertion about its ACL or link target.

Only these guard paths are eligible for output:

```text
/
/System
/System/Library
/private
/private/etc
/etc
/System/Library/OpenSSL
/System/Library/OpenSSL/openssl.cnf
/private/etc/codex
/private/etc/codex/requirements.toml
/private/etc/codex/managed_config.toml
/private/etc/codex/config.toml
```

The sequence stops at the original failure; a later unreported path was **not
inspected**, not proven absent. The diagnostic adds only `lstat` observations:
no `readFile`, `open`, `realpath`, `readdir`, policy link-target reads or contents.
Link targets are deliberately omitted because `lstat` cannot provide them;
there is no foreign-path/private-username disclosure to sanitize. The original
guard alone retains its exact `/etc` alias `readlink` check. No arbitrary path
argument, config parser or replacement policy implementation is introduced.

## Policy-preserving follow-up, not implemented here

1. Capture the exact block first. If the OpenSSL leaf is present, label the
   current result an **intentional absence-only compatibility block**. Do not
   infer that it is AI managed policy merely from the shared error code.
2. Keep the three Codex files absence-only/fail-closed. Distinguish any future
   trust decision for a fixed OS OpenSSL file from support for AI requirements,
   managed hooks or organization config; do not suppress or reinterpret those.
3. Separately review whether the root-owned OS file can be admitted read-only
   under a deliberate OS trust boundary: exact fixed path, regular non-symlink
   file, trusted root-owned non-writable ancestors and leaf, complete native ACL
   inspection, and race-resistant metadata identity. Owner/mode alone are not
   enough. `desktop/native/macos-acl.c:115–118` currently requires `S_ISDIR` and
   `O_DIRECTORY`; it cannot validate the file ACL. A file-metadata extension and
   real Darwin failure/ACL/symlink/race tests would be prerequisite work, not a
   permissive fallback in this diagnostic.
4. The profile already has an exact read-data/read-metadata rule for this leaf;
   no recursive OpenSSL directory access, writable config, executable mapping or
   provider/include-path grants should follow from a presence observation.
   Before proposing acceptance, check the pinned consumer's actual configuration
   behavior and the effect of denied dependencies. Do not implement speculative
   config parsing or assume root ownership makes configuration inert.

Apple's archived `OPENSSL_config` manual explicitly describes standard
`openssl.cnf` loading and configuration-driven dynamic ENGINE loading from
shared libraries.[1] This supports caution about treating a config read as inert;
it is historical documentation, not proof of the pinned modern Node/Claude
consumer or the runner's file contents. A benign-looking public Apple OpenSSL
example/template likewise would be only a reference, **not evidence that this
Mac's file matches it**. No machine policy contents were read here.

Do **not** disable OpenSSL configuration, set `OPENSSL_CONF=/dev/null`, delete or
rename present files, hide managed policy, relax unknown/error handling, weaken
ACL checks, or widen the production sandbox. None of those changes are made.
The stale `ls`-candidate caveat in `src/server/ai/macos.ts:22–23` is historical:
the current implementation imports the native ACL reader. It is pointed out
here rather than edited as part of this diagnostic-only scope.

## Verification performed on Linux

- TDD: the first attribution test failed before implementation (unmodified main
  ignored the metadata seam and returned `sandbox_unavailable`); then passed.
  The metadata-only option separately failed before implementation. Its
  executable-disclosure assertion also failed before the omission was added.
- `node_modules/.bin/tsx --test tests/macos-diagnostic-policy.test.ts`:
  **22 passed, 0 failed, 0 skipped**. Covers each leaf as present/symlink/unknown,
  absence observations, no policy content read, no target `spawn`, exact error
  class/code, no exception/private-string leak, strict options, metadata-only
  success, and failure propagation before all dispatch modes.
- `npm test`: **575 tests, 566 passed, 0 failed, 9 skipped**. Darwin runtime
  skips remain skips, not acceptance evidence.
- `node_modules/.bin/tsc --noEmit` and `git diff --check`: passed.

Only `scripts/macos-ai-diagnostics.ts`, `tests/macos-diagnostic-policy.test.ts`
and this document are changed. Production guard, native helper, sandbox profile
and launch policy are unchanged. Real Mac path attribution remains the next
metadata-only capture, not a result claimed from Linux.

## Sources

[1] https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/OPENSSL_config.3ssl.html — Apple archived OPENSSL_config manual
