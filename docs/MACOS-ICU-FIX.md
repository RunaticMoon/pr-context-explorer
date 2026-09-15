# Exact macOS ICU data allowance

## Evidence and scope

The credential-free macOS 15 / ICU 76 A/B run `34948353063`, job log
`artifacts/github-job-104313056553.log`, compared the same Claude `--help`
invocation with fresh private state. Baseline PID 6250 was killed by SIGKILL;
PID 6290, with only the following additional rule, exited 0 and produced
21,401 help bytes:

```scheme
(allow file-read-data file-read-metadata (literal "/usr/share/icu/icudt76l.dat"))
```

This establishes that startup comparison, not full confinement, native ACL
acceptance, authentication, or compatibility across macOS versions. Production
supports this fixed tested data layout; missing ICU 76 data fails preflight.
No version glob, fallback leaf, or compatibility claim for other macOS releases
is implied.

## Production boundary

The exact rule above is the only permission addition. No parent enumeration,
recursive read, executable mapping, write, Mach, JIT, fork, network, or managed
policy change is made. The existing low-level system-read guard checks ICU
before target execution. It performs metadata-only checks: the already checked
root and each literal `/usr`, `/usr/share`, `/usr/share/icu` directory must be
root-owned, not group/other writable, non-symlink, and native-ACL safe. Checking
every literal component rejects aliases rather than trusting only a final
realpath. The leaf must additionally be a regular file. Missing paths, unknown
metadata, all allow ACLs, incomplete inspection and native helper failures block
with `sandbox_unavailable`; only complete empty/deny-only ACL results pass.

The internal TypeScript regular-file ACL reader accepts exactly the OpenSSL
policy leaf and this ICU leaf, with no browser/environment override. It uses the
existing application-anchored trusted native helper and existing regular-file
mode; the C helper and its trust boundary are unchanged. Preflight does not read
ICU contents or execute inspected-repository code. OpenSSL host-policy trust and
Codex managed-policy refusal remain intact.

## Regression coverage and verification

The profile regression removes exactly the ICU rule and reproduces the prior
complete SHA-256 `665326db0be538eb6f1fde765c675c60546814c5f5cfffb3d283d1edf5b09e05`.
The older root/config subtraction check still reproduces
`6d018c27a3d192de5e65a5c6a3d0701245e781100c7180ad677f08b7534e4d1a`.
The new complete fixture profile SHA-256 is
`8bd691932ca445b665e6e82df65e490ec6f19657f708f215894931cd6188a947`.
These hashes apply to the exact fixture inputs in `tests/ai-macos.test.ts`.

Portable regressions cover trusted metadata, every new ancestor, missing and
unsafe objects, ACL errors and exact file-reader allowlisting. The Darwin-only
regression requires real native preflight, host-readable controls, sandboxed ICU
read/stat success, and EPERM/EACCES (never ENOENT) for parent enumeration and
sibling-subtree/passwd reads. It emits booleans/error codes, not ICU contents.
Existing root/symlink, auth/schema, network, child-denial, TLS and pinned official
Node/Codex/Claude probes remain mandatory on actual Darwin.

The first implementation-only Linux run recorded 645 passed, 1 failed and 10
skipped: the diagnostic wrapper's fixed metadata allowlist did not yet include
ICU paths. Parent integration subsequently added only the four fixed ICU paths,
forwarded the internal file-ACL test seam, and adapted the metadata-only fixture.
The parent full `npm test` then passed (`artifacts/icu-fix-parent-full.log`).
Independent review of the integrated change passed with 312 targeted tests,
10 Darwin skips and a successful typecheck. These are Linux checks, not Darwin
runtime acceptance.

The retained ICU A/B diagnostic is historical after this production change:
appending the same rule now duplicates an existing allowance and is no longer a
causal A/B. Its original guard/hash checks may deliberately refuse the changed
baseline. The parent diagnostic-wrapper integration above does not alter those
historical experimental profiles. No workflow change was needed for this fix.

Full actual macOS verification is still pending, including native ACL acceptance
of the fixed OS file and ancestors, the new confinement regression, standalone
Node startup, and official Codex/Claude help/status. Run the default full macOS
gate, not a startup-only marker. Do not report this patch as full Mac acceptance
until that run passes.
