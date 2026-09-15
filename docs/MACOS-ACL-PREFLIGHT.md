# macOS ACL absence-only preflight — review candidate, BLOCKED

**Do not treat this candidate as complete closure of the ACL trust gap or release it without parent security review. No Darwin execution has occurred here.**

## Implemented candidate

`validateMacSystemPolicyReads` now checks directory ACL text after each existing ancestor passes the existing uid-0 / non-group-or-other-writable / real-directory checks, before accepting policy absence. Every low-level production/diagnostic caller already uses this validator with no injected options.

Production inspection is restricted by the validator's literal path list: `/`, `/System`, `/System/Library`, `/private`, `/private/etc`, plus the optional existing `/System/Library/OpenSSL` and `/private/etc/codex`. The exact root-owned `/etc -> private/etc` or `/private/etc` alias remains required; its canonical directory target receives the same ACL validation. Existing configs, dangling links, unknown leaf metadata, writable/untrusted ancestors still block; no config is opened.

`macos-acl.ts` runs `/bin/ls` with argv `['-ldne', absolutePath]` (numeric owner/group header), `shell:false`, cwd `/`, and an explicit environment containing only `LANG=C` and `LC_ALL=C`. Each invocation is capped at 2 seconds and 16 KiB per captured stream, with SIGKILL on timeout. Nonzero exit, timeout, capture overrun and any stderr fail closed with `sandbox_unavailable`. The validator invokes at most seven readers sequentially and does not cache results. The generic read-only helper also supports canonical absolute temporary fixture paths; production never obtains paths or executors from environment/user configuration.

The bounded parser requires one complete directory header matching the requested path and contiguous numbered, understood deny-only entries. All allow entries are rejected, including read-only grants and root principals; it does not try to resolve effective identities or evaluate ACL ordering. Common `group:everyone deny delete` and recognized deny inheritance are accepted. Unknown rights/types, malformed/truncated text and control characters fail. `@` headers do not hide following ACL entries. This text classification is **not proof that ls successfully obtained a complete native ACL**.

## Newly discovered blocking limitation of ls

Apple's source distinguishes neither a NULL `acl_get_link_np` result nor a failed first-entry read from an empty ACL in the printed header. It can produce ordinary no-ACL output without warning. `printacl` also silently continues after failures retrieving entry fields. Thus exit 0 + empty stderr + apparently ACL-free output is not sufficient proof of successful ACL inspection. A parser cannot recover information the command suppresses.

Source inspected directly (not executed):

- https://github.com/apple-oss-distributions/file_cmds/blob/main/ls/ls.c — `np->acl = acl_get_link_np(filename, ACL_TYPE_EXTENDED)`; NULL / failed `ACL_FIRST_ENTRY` path; `mode_suffix` assignment.
- https://github.com/apple-oss-distributions/file_cmds/blob/main/ls/print.c — `printacl`, silent `continue` on tag/flag/permission/qualifier failures.

These moving-source links document the observed issue, not a pin or a verified installed Darwin binary version. No native ACL-read failure has been reproduced on this Linux host. The dangerous case is specifically relevant to a non-owner process inspecting root-owned ancestors; an own-directory fixture cannot establish non-owner behavior. A deny-readsecurity fixture is included as an additional native guard, but even passing it as the owner cannot rule out suppressed native errors.

**Remaining decision:** use a reviewed native ACL API bridge which exposes success/error and complete enumeration, or explicitly approve another dependency/approach. A bundled native helper/FFI dependency was not added under the no-new-binary-dependency constraint. Executing a scripting runtime as a substitute was not silently introduced. Merely rejecting reported errors does not satisfy the requested unknown-inspection fail-closed guarantee.

## Tests and safety

TDD cycles observed red then green for: root-owned 0755 + ACL create grant; supported deny-only parsing; fixed bounded native invocation; invalid path / stderr / command failure handling; malformed/control/oversized output. Additional regressions cover every fixed ancestor and visible allow mutation/metadata/permission grants. The trusted `readAcl` seam is only a source-level extension of the existing metadata fixture interface.

Local commands:

```sh
node_modules/.bin/tsx --test tests/ai-macos-acl.test.ts tests/ai-macos-system-policy.test.ts
node_modules/.bin/tsc --noEmit
npm test
```

Verified Linux results: targeted ACL/system-policy tests **185 passed, 1 Darwin-only skipped**; full `npm test` **536 passed, 9 skipped, 0 failed** (545 tests); `tsc --noEmit` and `git diff --check` passed. Logs are `/tmp/prce-acl-targeted.log` and `/tmp/prce-acl-full.log`. These results do not resolve the ls completeness blocker.

Darwin-only native tests create canonical fresh own temporary directories and invoke `/bin/chmod` with argv arrays to set/clear ACLs **only on those fixtures**. They exercise ACL-free, common deny-delete, create-directory/file allows, metadata/security allows, deny-readsecurity plus allow, and missing-path error. They assert mode remains non-group/other-writable. They never use sudo, change actual system-directory ACLs, create/delete root configs, run target engines, or skip unknown inspection on Darwin. Only non-Darwin platforms skip the native test.

Parent review must occur before any macOS CI execution; no commit, push, Actions dispatch, credentials, remote execution or signing/policy changes were performed. Root/admin concurrent mutation remains outside the stated model, but ACL-enabled non-root substitution is not excluded. Linux unit success is neither Darwin verification nor full security certification.
