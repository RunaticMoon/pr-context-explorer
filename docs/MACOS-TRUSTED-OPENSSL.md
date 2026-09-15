# Trusted macOS OpenSSL host policy

## Reason and exact scope

The supplied run `34944208393`, log `artifacts/github-job-104299651842.log`,
passed native ACL build and Darwin directory fixtures, then stopped at the
absence-only preflight. Metadata identified the exact
`/System/Library/OpenSSL/openssl.cnf` as a root-UID-0, mode-0644 regular file.
That evidence identifies a host compatibility blocker, not target execution
success. This change accepts that **trusted host crypto-policy boundary**;
it does not suppress OpenSSL configuration or accept AI managed configuration.

## Acceptance and refusal

Before each launch, the unchanged top-down ancestor checks require root-owned,
non-group/world-writable directories with fully inspected empty or deny-only
ACLs. The sole `/etc` alias remains explicitly validated. The fixed OpenSSL
leaf may be genuinely absent. If present, it must be a non-symlink regular file,
UID 0, with `(mode & 022) == 0`; execute permission is not required. Its native
ACL must be empty or deny-only. Every allow ACE is refused, even read-only,
root-principal, inherited or inherit-only grants. Unknown ACL/API/metadata
results fail closed; a failed ACL inspection is never reclassified as absence.
Special files, FIFO, device, directory, dangling/file symlink, unprivileged
owner, and group/world-writable policy cannot pass.

`requirements.toml`, `managed_config.toml` and `config.toml` under the fixed
Codex system location remain **absence-only**: any present object, even an
empty root-owned read-only regular file, blocks with
`managed_policy_unsupported`. Existing provider/MDM guards are unchanged.

## Native bridge and privileges

The native helper's existing `<directory>` invocation remains strict and uses
O_DIRECTORY. The only new protocol input is `--regular-file <absolute-path>`.
The internal TypeScript `readMacFileAcl` allows only the exact OpenSSL leaf;
there is no browser, plugin, environment or request override. Native own-temp
fixtures invoke the executable directly for file API coverage, not a broader
production TypeScript path allowance.

File mode opens read-only with O_NOFOLLOW/O_CLOEXEC/O_NONBLOCK, checks the
expected type before open and through full stat-mode identity comparisons,
and uses the same descriptor-bound fstatx/filesec metadata, complete exported
ACL count, every checked getter, cleanup, and final path/FD identity checks.
It never reads file contents. O_NONBLOCK prevents a raced-in FIFO from hanging;
post-open type/identity mismatches still fail. The v1 stdout grammar is unchanged:
only exact empty/deny-only lines with exit 0, no stderr, bounded output and
runtime are accepted. Unsafe exits 2; errors exit 1. No sensitive metadata or
configuration/source/credential contents are emitted.

**No SBPL rights are added or changed.** The existing exact OpenSSL
file-read-data/file-read-metadata grant suffices. There is no broader file read,
executable mapping, Mach, fork, JIT or network change, no `/dev/null`, no
OPENSSL_CONF override, and no configuration copy, content parser or omission.
The native consumer reads the original policy normally. Policy
includes/providers/extensions may access only files/code already permitted by
the original profile. Unsupported dependencies remain denied and failures are
not retried with suppression or broader rights.

## Trust limitations and verification

Root/admin-controlled OS policy contents and mutation are explicitly outside
the unprivileged threat boundary. Host policy is trusted, not proven harmless;
this is not an atomic defense against a malicious root administrator. The
installed app/native resources must already be trusted; helper discovery does
not close a compromised application installation. Unprivileged ACL grants,
writable modes and path substitutions must remain blocked.

Linux tests compile the actual C source with synthetic Darwin API shims in
both modes, including every getter failure, malformed ACL, type rejection and
path/mode mutation. TypeScript tests cover exact file argv/protocol, fixed-path
restriction, trusted OpenSSL metadata, unsafe ACLs, and strict Codex refusal.
The original full profile hash regression remains unchanged.

Linux verification for this implementation: `npm test` passed 641 tests with
9 Darwin skips (650 total); `npx tsc --noEmit` and `git diff --check` passed.
These counts are local control-flow/build checks, not actual Mac acceptance.

Actual Darwin fixtures now also build and inspect own temporary regular files
with absent, deny-only and read/write-allow ACLs, without sudo or host policy
modification. Linux success is not Darwin API or Seatbelt evidence. The parent
must run the real Mac gate and adapt the runtime absence-only OpenSSL assertion
to the observed trusted-file case without logging policy contents; Node startup,
Codex bootstrap and confinement remain pending actual Mac execution.
