# Literal-root loader allowance

## Change and disclosure

The only production Seatbelt permission added is:

```scheme
(allow file-read-data (literal "/"))
```

This permits opening/reading the root directory, including enumeration of its
entry names. That is a new disclosure, not unrestricted filesystem access:
`literal "/"` does not match descendants. It is not `subpath`, a prefix, a glob,
`file-read*`, a global metadata grant, or any file-write grant.

The rule addresses the tested Claude early OS-loader startup failure. All other
policy is unchanged: deny-default, denied fork, no Mach grants, exact executable,
existing system loader paths, private scratch writes, read-only auth/schema,
and exact already-owned localhost proxy port. No permission was added for
`kern.osvariant_status`, `/var` metadata, or `notification_center`.

## Actual experiment (historical evidence)

CI run **34936195552**, job **104274510893**, captured in
`artifacts/github-job-104274510893.log`, ran the same credential-free
Claude `--version` launch with one profile-rule difference:

| Variant | Profile SHA-256 | Actual result |
| --- | --- | --- |
| Baseline | `a90a5ce81ae40a50ba39d3a504b8e7d267443c9efa2fcccd841a4a713373dedb` | PID 4691, SIGABRT, no stdout |
| Literal-root data read only | `54dc2615bb2502e953c89c711da0f1338efcd5293f48d66188d62fdc636f0cbd` | PID 4881, exit 0, `2.1.270 (Claude Code)` |

Other logged denials remained and did not prevent this version launch. The
experiment supports this minimal change for that early-loader path; it does not
prove full confinement, standalone Node or Codex compatibility, help/status,
TLS, or authenticated inference. Rejected/redacted crash identities remain
unverified; no private libignition abort-code interpretation is asserted.

The retained diagnostic `--startup-ab-root-directory` is now **historical
experiment tooling**, not a fresh pre-fix/post-fix comparison: its baseline uses
current production, which already contains the rule, and its variant appends a
duplicate. Existing diagnostic tests still validate that single appended rule.
Use the archived experiment for causal evidence and the full Darwin suite for
verification; do not interpret rerunning that flag as a new A/B proof.

## Regression and runtime acceptance

- The constructor regression was written first and failed because the exact
  literal-root rule was absent (`0 !== 1`), then passed after adding only it.
- It requires exactly one standalone root-data rule, permits only the existing
  root metadata line alongside it, and freezes the entire remaining profile via
  a SHA-256 of the pre-fix profile for fixed executable/scratch/auth/proxy inputs.
  Any other permission change fails, including broad root regex/prefix/writes.
- The actual Darwin probe now requires successful root enumeration **and**
  denied enumeration of `/private` (an existing immediate root child), the
  host-readable outside directory, and a symlink to that directory. Controlled
  outside file reads/writes/creation and file/directory symlink escapes must be
  denied. The preexisting `/etc/passwd` read denial remains mandatory.
- Positive unsandboxed reads/listings establish that denial targets exist and
  are host-readable. The host rechecks that the controlled sentinel is unchanged
  and no outside file was created. Tests do not create files on the sealed `/`
  volume or need privilege: a private `/private/tmp` directory outside all
  allowed scratch subpaths supplies the safely created file. `/private` tests
  the immediate root child boundary; `/etc/passwd` tests existing descendant
  contents, not a newly created immediate-root regular file.
- The focused actual-Darwin test returns named syscall outcomes and accepts
  **only EPERM/EACCES** for denials, never ENOENT. The existing runtime probe
  still requires scratch access, auth/schema read-only, detached child/shell
  spawn denial, denied live IPv4/IPv6 loopback, external TCP and Unix sockets,
  and allowed proxy responses rejecting forbidden authorities. Socket timeout,
  refusal or successful connection is not permission-denial evidence.
- Existing six Darwin runtime cases remain mandatory on Darwin ARM64; the new
  focused root-boundary case is mandatory there too. Only non-Darwin-ARM64 hosts
  skip these tests; no unavailable-or-success fallback was added.

## Verification handoff

Local execution for this patch:

- `tsc --noEmit` and `git diff --check`: pass.
- Targeted `ai-macos*.test.ts` plus `ai-runner.test.ts`: 34 passed, 7 Darwin
  cases skipped on Linux, 0 failures. The retained A/B runner tests pass.
- Full `npm test`: 340 passed, 7 Darwin cases skipped, 1 unrelated existing
  failure in `tests/distribution-release.test.ts:44` (workflow pin-line format
  requires `/@[a-f0-9]{40} /`; the native-diagnostic checkout line lacks the
  expected suffix). The unchanged line is present in HEAD 294bcda. No workflow
  edits were made in this patch; the parent owns that fix. Full output is in
  `artifacts/macos-root-loader-linux-suite.log`.

Local Linux constructor/full-suite results are not Darwin kernel verification.
The parent must independently security-review the diff and run the full approved
Apple Silicon suite, including real Node confinement, both pinned CLI help/status
checks, timeout/PID cleanup, TLS/system CA and packaged integration as applicable.
No credentials or inference are needed for these checks. If startup or a strict
denial assertion fails, retain the policy and report the exact PID/exit/signal
and bounded no-auth denial evidence; do not add speculative permissions.
