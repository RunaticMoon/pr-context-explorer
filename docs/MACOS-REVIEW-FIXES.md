# Independent macOS validation review fixes

## Scope and approval boundary

These are local validator/updater fixes, not permission to change or run GitHub Actions. No `.github/**`, CI scripts, root package files, Linux ELF validator, Seatbelt grants or proxy implementation were edited for this work. No push, workflow dispatch, real GitHub/credential access, Apple tooling or native fixture execution was performed. All execution evidence below is from Linux; actual Darwin acceptance remains outstanding.

## Findings and remedies

### R1: unchecked alternative ARM64 slice

A constructive universal Mach-O with an ordinary ARM64 first slice and an ARM64e second slice containing `LC_DYLD_ENVIRONMENT` was accepted, although that second slice alone was rejected. The validator selected the first ARM64 entry while dyld could select an alternative.

The conservative fix rejects multiple ARM64 entries (including ARM64e alternatives) in both 32-bit and 64-bit universal tables. A single ARM64 slice may coexist with an x86_64 slice. Every table entry must have safely representable, file-bounded offsets/sizes, start after the table, satisfy its alignment, and not overlap another slice; FAT64 reserved fields must be zero. The selected executable's CPU type/subtype must match the ARM64 table entry, and its load commands must remain inside its declared slice, not merely inside the whole file. Existing DYLD-environment and non-system dependency rejection remains in force. This is not full support for every Mach-O variant.

### R2: symlink target normalization hid unsafe traversal

`path.resolve(parent, target)` erased `unsafe/..` before permission inspection. A link to `unsafe/../engine` therefore hid a mode-0777 ancestor.

Symlink targets now retain their literal components until the walker visits each one. Each `..` is applied only after the preceding component (and any symlink target) has been checked. Relative `../engine` and nested trusted installation links remain supported; unsafe relative and absolute target traversal is rejected. Ownership, writable-ancestor checks, the narrow sticky temporary-root exception, link limit and final realpath comparison remain unchanged. Fixture permissions are changed only inside newly created private temporary directories.

### External personal updater host pin

`distribution/prce` previously inherited `GH_HOST`, allowing its unqualified fixed repository to be routed to an ambient Enterprise host. Its central `gh` wrapper now sets child `GH_HOST=github.com`, adds explicit `api --hostname github.com`, and qualifies release repositories as `github.com/RunaticMoon/pr-context-explorer`. The wrapper rejects explicit hostname overrides and unexpected release sources. Credentials are still handled by `gh`, never obtained or printed by the manager.

The regression launches only a private fake `gh` executable. It exercises latest and pinned release resolution, annotated tag resolution and release download, inspecting all ten child argv/environment records under `GH_HOST=evil.test`. Only a synthetic token sentinel is supplied; it never appears in captured output or the fake log. No real GitHub executable, service or account is contacted.

### Opaque TLS limit

`MACOS-ISOLATION.md` now distinguishes CONNECT authority/public DNS-IP/port enforcement from encrypted request identity. The proxy forwards opaque TLS; matching SNI and encrypted HTTP `Host`/`:authority`, and certificate verification, depend on the trusted pinned CLI. It is not an independent proof of encrypted request authority. No MITM, trust-root change, TLS-disable flag or broader profile was added.

## Permanent RED/GREEN evidence

- `tests/ai-macos-validation.test.ts`: the multi-ARM64 fixture first failed with **Missing expected rejection: second ARM64 slice must not bypass validation**; passed after rejecting multiple slices.
- The universal metadata regression first failed on a table/header subtype mismatch; after bounded table validation, both FAT32/FAT64 positive containers and subtype/size/alignment/overlap/unsafe-offset negatives passed.
- The symlink regression first failed with **Missing expected rejection: literal writable traversal must be inspected**; passed after preserving literal target components, including positive trusted relative/nested links.
- `tests/distribution-manager.test.ts`: the hostile-host regression first failed with **ambient GH_HOST reached gh**; passed after pinning explicit routing and child environment.

All Mach-O fixtures are byte buffers read by the validator, never executed.

## Final local verification

- `node_modules/.bin/tsx --test tests/ai-macos*.test.ts tests/distribution-manager.test.ts`: **23 tests, 17 passed, 0 failed, 6 Darwin-only skips**.
- `node_modules/.bin/tsx --test tests/ai-*.test.ts tests/distribution-*.test.ts`: **146 tests, 139 passed, 1 failed, 6 Darwin-only skips**. The sole failure is the existing parent-owned `personal Mac CI prepares pinned native engines and exercises actual Electron launches` assertion in `tests/distribution-release.test.ts`; the workflow lacks the expected pinned CLI setup. That approval-blocked workflow/test boundary was left untouched, not hidden or weakened.
- Project `node_modules/.bin/tsc --noEmit`: passed.
- Python `compile()` of `distribution/prce`: passed without writing bytecode artifacts.
- Owned TypeScript files formatted with the already-installed Prettier; `git diff --check`: passed.
- Actual Linux `probeSandbox()`: `backend: "linux-bwrap"`, `available: false`, `runtimeVerified: false`, blocker **Kernel denied namespace or loopback setup (EPERM); no unsandboxed fallback.**

No new dependencies were installed. These results do not claim Mac runtime, native CLI compatibility, authenticated inference, signing, notarization or hosted Actions success.
