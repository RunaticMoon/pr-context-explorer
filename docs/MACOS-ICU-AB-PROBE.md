# Claude help: fixed ICU data-file A/B diagnostic

## Evidence and hypothesis (not a crash-code decode)

Actual Mac minimal CI run `34945749500`, job `104304609839`, local artifact
`artifacts/github-job-104304609839.log`, reached the native ACL regular-file
fixtures and host policy preflight. The unchanged-profile `claude --help`
launch PID **18621** returned empty output, null exit code, and **SIGKILL**.
The fresh IPS candidate matched PID/time but not the full executable path;
its `FOUNDATION`, code `1`, `EXC_BREAKPOINT` fields remain an
**unverified-executable-match hypothesis**, not a verified crash summary.
No source here decodes Foundation termination code 1.

Kernel messages include denied metadata access to
`/usr/share/icu/icudt76l.dat`, Cryptex paths and `/var`, plus Mach service
lookups. Notification-center denial also occurred before a successful
`--version` launch: it is not evidence that this service is fatal. This
experiment grants no Mach permission.

There is enough source association to test the ICU leaf, not to call it the
cause:

- Apple's [CFLocale.c, pinned CF revision dc54c6b](https://github.com/apple-oss-distributions/CF/blob/dc54c6bb1c1e5e0b9486c1d26dd5bef110b20bf3/CFLocale.c#L850-L852)
  uses ICU locale data (`ulocdata_open`, `ulocdata_getExemplarSet`). This is
  historical CoreFoundation source, not proof of the current Foundation
  startup call stack.
- Apple's [ICU udata.cpp, pinned revision 9e80977](https://github.com/apple-oss-distributions/ICU/blob/9e80977766f830c93e3cdae3d5628997e1a61b63/icu/icu4c/source/common/udata.cpp#L73-L74)
  identifies the main data location as `/usr/share/icu/` and separately
  describes timezone data. This does **not** justify granting timezone paths.
- The same revision's [POSIX uprv_mapFile](https://github.com/apple-oss-distributions/ICU/blob/9e80977766f830c93e3cdae3d5628997e1a61b63/icu/icu4c/source/common/umapfile.cpp#L209-L242)
  calls `stat(path)`, `open(path, O_RDONLY)` and `mmap(..., PROT_READ, ...)`.
  Thus metadata plus data read on the denied leaf is a grounded single
  policy-variable experiment; executable mapping/JIT permission is not.
- [u_init documentation](https://github.com/apple-oss-distributions/ICU/blob/9e80977766f830c93e3cdae3d5628997e1a61b63/icu/icu4c/source/common/unicode/uclean.h)
  says initialization attempts to load some ICU data and reports inaccessible
  required data. It does not establish that this Claude launch calls `u_init`
  or that inaccessible data maps to Foundation code 1.

The **76** filename comes from the observed kernel denial, not an assumption
that this public source revision matches the installed OS binary.

## Run once on the same real Darwin arm64 host

After the existing trusted native CLI/helper setup, with no credentials:

```sh
node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --startup-ab-icu-file
```

The diagnostic intentionally exits **1**, even if both launches succeed.
Capture stdout/stderr as the existing bounded diagnostic-stage artifact;
do not attach it to a model run or interpret it as a readiness gate. There
are no CLI path, profile, environment, auth, or arbitrary-argument overrides.
The flag must stand alone; combined/unknown flags are rejected.

## Exact experiment contract

A is the unchanged production generator with no credential/schema/network
inputs. B is that identical profile plus exactly one line:

```scheme
(allow file-read-data file-read-metadata (literal "/usr/share/icu/icudt76l.dat"))
```

Nothing is removed. No parent metadata, recursive access, Cryptex, `/var`,
Mach, service, or executable-mapping permissions are added. Production
`src/server/ai/**`, the native helper, and its C source remain unchanged.
The old `--startup-ab-root-directory` mode retains its version-only plans;
it is historical now that production already allows literal-root reads.

Before discovery and before each variant, the ICU mode performs its own
fixed-leaf host `lstat` positive control. It emits only existence, UID, mode,
regular/symlink/other type, and acceptance. It requires a root-owned regular
non-symlink file with no group/other write bits. It reads no ICU contents,
resolves no symlink targets, and stops on absence, symlink, unsafe metadata,
or unknown errors. This is a metadata control, **not** proof that ICU can
load the data and not a replacement for the production native ACL guard.
`validateMacSystemPolicyReads()` remains at entry and immediately before
**each** target spawn. If any extra path is required, stop and report it;
do not broaden or re-run with additional grants.

Both variants use the same resolved executable, `--help` argv, fixed clean
environment and identical absolute scratch path strings. Private scratch
children are removed/recreated between A and B, then the root is cleaned up.
Each target is limited to 10 seconds, 64 KiB stdout, 64 KiB stderr and
128 KiB combined. Profiles and their SHA-256 hashes are emitted verbatim.
The host reads the existing fixed system CA as before; no credentials,
auth status, capabilities, proxy or inference dispatch is entered.

Output stages are scoped to `startup-ab-icu-file-*` (contract, host metadata,
outcomes) and `claude-startup-ab-icu-file-{baseline,literal-icu-file}-*`
(exact profile, result, log scope/log, bounded crash summaries/rejections).
Target help PID, executable, profile hash and launch timestamps are distinct
from the log-reader PID. Logs are bounded to the existing two-minute query,
10-second reader deadline, 64 KiB stdout/4 KiB stderr. Review timestamps as
well as PID; missing/empty logs are not evidence of no denial. Fresh IPS
collection keeps the existing exact identity/time and payload bounds.

## Falsifiable interpretation

| Result | Interpretation / next action |
| --- | --- |
| A reproduces SIGKILL, B prints help and exits 0 | Supports the exact leaf permission as sufficient for this startup on this host. Does not decode Foundation code 1, prove general causality, or verify confinement. No production promotion. |
| Both fail, ICU denial disappears in B | This leaf alone is insufficient. Inspect bounded B PID/time evidence; stop rather than add another grant. |
| Both fail, ICU denial remains | The literal rule did not establish the intended access (possible alias/dependency/policy issue). Stop and report; no parent/path widening. |
| A succeeds | Baseline failure did not reproduce; no causal conclusion from this pair. |
| Host metadata or policy guard rejects | No authorized pair exists. Report the blocker, not an ICU result. |
| Timeout/output cap/unknown launch error | Inconclusive bounded experiment, not successful startup. |

Linux tests verify strict flags, exact policy delta/hash, identical help
inputs and bounds, metadata rejection and historical root-plan behavior.
They cannot verify Seatbelt, actual OS metadata, or a Foundation crash.
Only the subsequent real Mac stage can supply that result.
