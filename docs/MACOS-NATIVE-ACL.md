# Native macOS ACL bridge: bundling contract

Build on macOS only: `node scripts/build-macos-acl.mjs` (host architecture), or
`node scripts/build-macos-acl.mjs --arch arm64` / `--arch x86_64`.
Output: `desktop/build/runtime/native/prce-macos-acl`, mode 0755.
Run AFTER desktop/build.mjs (which removes generated runtime output). Package
this file inside the existing runtime extraResource, outside ASAR, preserving
execute permission. The native helper links only Apple system libraries. Build
requires Xcode Command Line Tools; end users require neither clang, Python, an
FFI module, nor a Developer ID. Existing unsigned/ad-hoc app distribution policy
is unchanged; no quarantine removal or platform-security bypass is introduced.

Discovery is anchored to import.meta.url, never cwd, PATH, browser input, or an
environment override: compiled runtime/src/server/ai/macos-acl.js resolves
../../../native/prce-macos-acl. Source .ts resolves
../../../desktop/build/runtime/native/prce-macos-acl. Do not bundle/relocate this
module without preserving that layout. Missing, symlinked, non-regular or
non-executable helper means sandbox_unavailable; there is no ls fallback.
The code-only executor seam is for internal tests, never a request field.

Protocol v1: exactly one normalized absolute directory argument by default.
The sole explicit type option is `--regular-file <absolute-path>` for metadata-only
regular-file inspection; the production TypeScript reader restricts it to
`/System/Library/OpenSSL/openssl.cnf`. Both modes reject unknown/extra options,
relative paths, dot components, controls, repeated separators or trailing slash
(except `/`). stdout is exactly one of these ASCII lines:

- `{"version":1,"status":"empty"}\n`
- `{"version":1,"status":"deny-only"}\n`
- `{"version":1,"status":"unsafe"}\n`
- `{"version":1,"status":"error"}\n`

Only the first two with exit 0 and empty stderr are accepted. unsafe exits 2;
error exits 1. No filenames, identities, ACL content, environment, or credentials
are emitted. Parent uses execFile, clean LANG/LC_ALL, cwd `/`, SIGKILL timeout
2000ms and 1024-byte output cap. Helper also arms a two-second alarm.

Implementation/review evidence and native verification status follow below.

## Native API and completeness proof

The implementation deliberately uses the descriptor-bound public
`fstatx_np` / `filesec_*` API, not `acl_get_link_np` as the absence oracle.
Apple's `acl_get_link_np` can return NULL both for actual absence and for failure;
checking errno does not supply the required positive completion proof. Its
underlying native metadata API is used directly so every observable return code
and required snapshot property can be checked. No NULL ACL is accepted.

1. Reject lexical aliases and all symlink components via exact `realpath`
   comparison; require the selected type using lstat before opening. Default
   directory mode uses O_RDONLY/O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC; regular-file
   mode uses O_RDONLY/O_NOFOLLOW/O_CLOEXEC/O_NONBLOCK (so a FIFO replacement
   cannot block). No file bytes are read. Full mode, owner, group and identity
   comparisons revalidate the expected type after open, statx and final stat.
2. Create a fresh filesec, require successful `fstatx_np`, matching stat identity,
   positive `fpathconf(_PC_EXTENDED_SECURITY_NP) == 1` (unsupported/error is not
   absence), and independently successful FILESEC_OWNER/GROUP/MODE values matching stat.
   Only then may successful `filesec_query_property(FILESEC_ACL)` returning
   exactly zero establish absence. This also rejects Libc's historical statx
   realloc-failure path, which can return zero without populating filesec.
3. For a present ACL, require successful `filesec_get_property` and non-NULL ACL.
   Use `acl_size` and `acl_copy_ext_native` to obtain the public kauth_filesec
   representation. Validate magic, bounded entry count, exact copied size and
   complete ACL flags. Do not read private opaque Libc structures.
4. Enumerate exactly that independently checked count. Darwin `acl_get_entry`
   returns **0** for success, **-1/EINVAL** for both exhaustion and invalid data,
   unlike the common POSIX convention. A failed first/middle entry never proves
   absence. Require the expected end only after all counted entries passed.
5. Require tag, allocated qualifier, permission-set/mask, individual permission,
   flag-set and every individual flag bit to succeed and agree with the exported
   snapshot. Reject unknown tags, permission bits and flag bits. Opaque UUID
   qualifiers are byte-compared, never resolved: any structurally valid deny
   cannot grant access, regardless of principal identity. Reject every allow,
   including read-only, inherited and inherit-only entries. Scan the entire ACL
   even after an allow so later getter failures remain errors.
6. Free each qualifier and ACL using acl_free, the filesec using filesec_free,
   and the exported allocation using free. Check path/FD identity and metadata
   (including nanosecond ctime/mtime) again before returning success.

Reviewed Apple Libc revision
[`71bbe350ab79eef58113991d817ccc6165061a64`](https://github.com/apple-oss-distributions/Libc/tree/71bbe350ab79eef58113991d817ccc6165061a64):
[acl_file.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/posix1e/acl_file.c),
[acl_entry.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/posix1e/acl_entry.c),
[acl_translate.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/posix1e/acl_translate.c),
[acl_perm.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/posix1e/acl_perm.c),
[acl_flag.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/posix1e/acl_flag.c),
[filesec.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/filesec.c),
[statx_np.c](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/sys/statx_np.c).

## Trust and race boundary

The helper itself performs no credential/configuration-content read or write and
never invokes another executable. The application must inspect the fixed system
ancestors top-down: root ownership, non-writable Unix mode and a safe ACL must
all pass before descendant trust is used. `/etc` is not a helper exception: the
external preflight validates the exact root-owned alias and sends its canonical
`/private/etc` target. Test-owned directories exercise APIs but do not establish
non-owner access to root-owned system ancestors.

Checks are not an atomic lock against concurrent root/admin changes. Host root,
admin-managed installation replacement, mounts, and mutation by the trusted app
owner are outside this boundary. Trust the installed application source and
native resources, never files from the PR target repository. The helper cannot
close an insecure app-installation boundary. FD identity plus repeated metadata
checks detect ordinary replacement during inspection; they do not claim to
prevent root racing after preflight. Never broaden the production config policy
or ignore real managed configuration to make these checks pass.

## Verification gates

Linux compiles the **actual helper source** against a clearly synthetic,
compile-time API shim in `tests/fixtures/macos-acl-shim`. Its failures cover NULL
ACL, first/middle/end iteration, tag/qualifier/permission/flag getters, unknown
bits/tags, size/copy/count errors, incomplete statx, query/property failures and
cleanup failure. Both directory and regular-file modes exercise the same failures,
including OWNER/GROUP/MODE failures/mismatches and path/mode mutation. There is no
failure-injection environment variable or test hook in the production binary. Linux results prove control flow only, not Darwin API or
kernel behavior.

The Darwin-only test builds with real Apple headers and runs real temporary
owner fixtures: directory and regular-file absent/deny-only/allow ACLs,
read/create allow, inherited allow/deny,
hidden-read ACL, malformed chmod input, missing target and symlink rejection.
It must fail (not availability-skip) on macOS if compilation or helper execution
fails. Helper-file symlink/permission checks and exact-wire negative tests run
portably. **Actual Darwin compilation/execution remains unverified in this
Linux implementation session**; run the approved macOS gate before treating this
candidate as runtime-verified. Desktop build/packaging integration must preserve
the contract above; no workflow changes are owned by this implementation.
