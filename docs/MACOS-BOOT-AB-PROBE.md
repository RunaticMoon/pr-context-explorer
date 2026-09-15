# Credential-free Mac loader A/B: root directory only

## Status: hypothesis test implemented; Darwin outcome PENDING

This is not a fix, production readiness, or a confinement result. Production
`src/server/ai/**` is unchanged and remains fail-closed with no silent fallback.

## Evidence and source investigation

- Actual CI run 34932821826, job 104264434466, local
  `artifacts/github-job-104264434466.log`: decoded exact-PID unified log says
  `Sandbox: claude(13874) deny(1) file-read-data /`.
- Actual minimal CI run 34935566429, job 104272585237, local
  `artifacts/github-job-104272585237.log`: launch PID 16466, early SIGABRT;
  PID/time-correlated IPS has a redacted executable path and remains
  **unverified-executable-match**. Its faulting symbols include
  `__abort_with_payload`, `abort_with_reason`, `ignition_halt`, `boot_boot`,
  `ignite`, and `dyld4::CacheFinder::CacheFinder`. This is not a verified IPS
  identity, nor evidence that the prior root denial caused this abort.
- Namespace `<0x23>` is LIBIGNITION (35), per Apple's pinned
  [XNU reason.h, xnu-11417.140.69](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/sys/reason.h).
  **The exact meaning of LIBIGNITION code 2 remains unknown.** It is not an
  errno decoding or a code from GUARD/DYLD.
- Inspected Apple's [dyld-1378 DyldProcessConfig.cpp](https://github.com/apple-oss-distributions/dyld/blob/fd8d0c4d52320ebf64db34f3cb280310d905c5ae/dyld/DyldProcessConfig.cpp#L1107-L1270).
  `CacheFinder` explicitly handles a cryptex from libignition, calls
  `ignite(&params, &ignitionPayload)` at line 1194, and consumes shared-cache
  and OS-graft FDs. That supports an early loader/bootstrap hypothesis. This
  public source is not established as the exact CI OS binary source and does
  **not** establish `boot_boot`'s root-open implementation or code-2 semantics.

Ranked falsifiable hypotheses:

1. Denied read-open of `/` is a blocking bootstrap prerequisite. Prediction:
   granting precisely that operation changes the early abort (ideally to a
   successful `--version`). This is the only tested policy change.
2. Another precise loader/cache permission is also missing. Prediction: B
   still fails, possibly with a new exact-PID denial. Do not automatically add
   that rule; investigate it separately.
3. The root denial is incidental; signing, OS bootstrap state, or another
   non-policy incompatibility causes the abort. Prediction: no meaningful
   A/B change. A single ordered pair cannot exclude transient/cache effects.

The concrete denial plus matching bootstrap component is sufficient evidence
for a narrow experiment, not sufficient evidence to change production.

## Run exactly one pair

On a trusted real Darwin arm64 machine with the existing pinned Claude install:

```sh
node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --startup-ab-root-directory
```

The flag takes **no value**; target is fixed to Claude because it owns the
observed evidence. It cannot be combined with `--startup-only`, auth flags,
extra args, or profile strings. Unknown, duplicate, or malformed options fail
before discovery/spawn. No arguments retains the existing production-profile
script behavior. Non-Darwin exits unsupported without a target launch.

The diagnostic deliberately exits **1 even if B succeeds**: consume the
structured `startup-ab-outcomes` record as experimental evidence, never use
its success as a readiness gate. A CI caller may explicitly capture this
expected nonzero diagnostic status without hiding the JSON results.

## Controlled variable and bounds

A is the exact unmodified production `buildSeatbeltProfile` with empty readOnly
and no proxy. B is those exact bytes followed by one newline and only:

```scheme
(allow file-read-data (literal "/"))
```

Both exact profiles and their SHA-256 digests are emitted, along with the
added rule and empty removed-rule list. Each variant has its own labeled
result, host-spawned PID, timestamps, exit/signal and bounded stdout/stderr.
OS-log records distinguish the target PID from the log-reader PID. Existing
fresh-IPS filters retain exact identity/time checks and explicit rejection
status; crash stages carry the variant name linked to its profile hash.

Both launches use the same validated executable, fixed `--version`, minimized
production-equivalent environment, exact cwd/HOME/config/tmp path strings,
no stdin, no credentials, no model call, no repository/PR-source access, no
proxy, and no inherited parent environment. Fresh private scratch is created
once; its five app-owned child directories are removed and recreated before
each launch, preventing A's disk state from becoming a second variable.
Neither launch reads real auth/settings files. The host only validates native
installation and the system CA, prepares scratch, and reads bounded diagnostics.

Each target: 10-second deadline, 64 KiB stdout + 64 KiB stderr, 128 KiB total;
timeout/output overflow kills via the existing bounded runner and is labeled
as an error (that runner does not expose a partial PID/result on rejection).
One baseline and one variant, no automatic retries or further relaxations.
Each log query is exact-PID scoped, 10 seconds, 64 KiB stdout/4 KiB stderr.
Existing crash search has its unchanged 8-second scan deadline, 24 read
attempts, 2 MiB per candidate, and bounded allowlisted output. OS filesystem
I/O itself is not hard-preemptible by these userspace scan deadlines.
Scratch is removed in `finally`. No sudo, quarantine removal, DYLD override,
system-profile imports or production API profile override.

## Security and interpretation

The added literal rule allows reading/opening the **root directory itself**,
including enumerating its immediate entry names. It does not recursively allow
child-file contents, root-file writes, or grant `(subpath "/")`. Root listing
is still a real information disclosure and is acceptable only in this explicit
credential-free diagnostic, not silently in inference.

Fork/exec, file writes, network, Mach and all other policy bytes are identical.
No sentinel matrix is added here: `--version` success would not prove denied
outside reads, symlink escapes, detached children, auth/schema immutability,
or networking. Any production proposal still requires the real Darwin
sentinel matrix and a separate reviewed policy change.

Interpret A failure/B success as support for this permission being relevant,
not proof of the complete cause or a fixed product. Both fail: the single rule
is insufficient; report the exact signals and scoped evidence rather than
blanket-granting. Both succeed: baseline symptom not reproduced. B-only
failure: no support for the hypothesis. A/B ordering, shared OS/cache state,
and unsupported concurrent installation/path/scratch mutation races remain;
this experiment does not harden the existing trust/concurrency model.

## Local verification

RED: flag test failed because its parser did not exist; one-rule plan test
failed because the test-only module did not exist. GREEN: all 21
`tests/ai-runner.test.ts` tests passed, including exact profile difference,
SHA-256, equal launch inputs, malformed/exclusive flags and the real local
runner PID/signal, timeout, output-cap, env/cwd and cleanup regressions.
`tsc --noEmit` passed. Invoking the flag on Linux returned explicit unsupported;
combining it with `--auth` returned fatal without a host/launch record.
Linux cannot prove compilation or execution under Seatbelt. Actual positive
Darwin A/B evidence is pending.
