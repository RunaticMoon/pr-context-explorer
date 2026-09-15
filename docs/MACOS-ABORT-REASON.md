# Native abort namespace: evidence and next falsifiable probe

Investigated 2026-09-15 against checkout `e12b3121cc76121416e8989d4c2d059ce502f6e4`.
No production Seatbelt permissions, launch environment, executable matching, or
clock tolerances changed. No remote execution or CI dispatch was performed;
public Apple source was fetched read-only, without GitHub credentials.

## Actual evidence (not a synthetic crash fixture)

`artifacts/github-job-104270282609.log`, run `34934794644`, reports Darwin
`24.6.0`, arm64, Node `v24.20.0`. Its first PID/time-correlated candidate per target:

| Target | Host child PID | Launch delta ms | Capture delta ms | Reported path |
| --- | ---: | ---: | ---: | --- |
| node | 3824 | 7 | 16 | `/Users/USER/*/node` |
| codex | 3956 | 7 | 28 | `/Users/USER/*/codex` |
| claude | 3977 | 7 | 24 | `/Users/USER/*/claude` |

All three startup results have empty stdout/stderr and `SIGABRT`. All three
candidate hypotheses show `EXC_CRASH`, termination namespace **`<0x23>`**, code
**2**, `details: [null]`, `reasons: [null]`, and missing `asi`. Paths do not
exactly match the launched executables: these remain
`unverified-executable-match`, NOT verified crash attribution. Repeated reads
are not independent reports. No raw IPS was available for this investigation.

## Apple reference mapping: hex is not decimal

Fetched Apple's official [XNU `reason.h`, tag `xnu-11417.140.69`](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/sys/reason.h)
(commit `43a90889846e00bfb5cf1d255cdc0a701a1e05a4`) and checked the same
namespace definitions on `main` on the investigation date:

| Constant | Decimal | Hex |
| --- | ---: | --- |
| `OS_REASON_DYLD` | 6 | `0x06` |
| `OS_REASON_GUARD` | 23 | `0x17` |
| `OS_REASON_SANDBOX` | 25 | `0x19` |
| `OS_REASON_LIBIGNITION` | 35 | `0x23` |

Thus the literal observed `<0x23>` maps to **LIBIGNITION** in this reference,
not GUARD or DYLD. `GUARD_REASON_VIRT_MEMORY = 2` belongs to the GUARD
namespace and must not be borrowed to decode this code. Neither should 2 be
silently decoded as errno ENOENT, a signal, or a DYLD-specific reason. The
fetched header does **not** define LIBIGNITION code 2. Its exact meaning remains
unknown. The log's Darwin release alone does not establish the exact installed
XNU or libignition build; this is a reference mapping, not an asserted binary
version match.

Apple's [dyld `DyldProcessConfig.cpp`, tag `dyld-1286.10`](https://github.com/apple-oss-distributions/dyld/blob/dyld-1286.10/dyld/DyldProcessConfig.cpp)
(commit `9307719dd8dc9b385daa412b03cfceb897b2b398`), lines 1124 onward,
explicitly describes finding a shared cache via a cryptex from libignition.
`CacheFinder` calls `ignite(&params, &ignitionPayload)` and consumes
`pl_shared_cache`. This supports a loader/cache-initialization hypothesis; it
does not identify the denied operation, required path/service, or code 2.
This source version is also a reference, not a measured installed dyld version.

## Sanitizer finding: the depth-limit premise was false here

At the investigated HEAD there is **no `allowedScalarFields` recursive/depth
sanitizer** in `scripts/macos-ai-diagnostics.ts`. `terminationFields` already
preserves scalar strings in `details`/`reasons` arrays (first four input items,
1024 characters each), including the unverified path. Existing string tests
exercise that behavior. There is no evidence that a depth limit ate native
strings in this checkout.

The reproducible defect instead is `(Array.isArray(value) ? value : [value])`
followed by `text`: missing, null, or non-string fields become `[undefined]`,
which JSON serializes as `[null]`. Therefore the historical `[null]` output
cannot distinguish absent native text from non-string values. It cannot be
used to reconstruct lost strings or prove Apple supplied null.

The minimal fix drops non-string input items without recursively inspecting
objects/arrays. Valid bounded strings still survive, controls become spaces,
and fields with no accepted text serialize as `[]`. RED reproduced
`[undefined]` versus expected `[]`; GREEN covers scalar/array strings, missing,
null, numbers, objects, length/count caps, and both exact/unverified paths.
These fixtures are synthetic, not recovered crash contents.

Because reason strings may genuinely be absent, the correlated unverified
hypothesis additionally exposes `faultingSymbols`: only string `symbol` fields
from the first 16 frames of the numeric faulting thread (or triggered-thread
fallback), each capped at 512 characters with controls removed. No image paths,
addresses, offsets, registers, memory, environment, or raw report are added.
A separate RED/GREEN regression proves the new evidence, its bounds, and the
unchanged PID/time gate. Symbols remain untrusted candidate assertions, not
independent executable identity or permission evidence. Existing verified
summary format is otherwise unchanged.

## Ranked hypotheses and the smallest useful next observation

1. **Confinement interferes with libignition's shared-cache/cryptex discovery
   before CLI main.** Prediction: a same-launch faulting stack includes
   ignition/cache-finder initialization; an exact-PID native denial or bounded
   reason identifies one concrete operation/resource. Namespace alone supports
   investigating this component, not granting it permissions.
2. **Host libignition/cache state fails independently of Seatbelt.** Prediction:
   the same trusted binary's credential-free `--version` under an equivalent
   private scratch/minimal environment outside confinement also aborts. Such a
   separately authorized control would weaken the confinement hypothesis; no
   unconfined launch was added or executed here.
3. **The redacted-path candidate is not the exact launched executable.**
   Prediction: independently measured trusted-binary identity would disagree
   with the candidate. PID/time correlation makes this less compelling but
   does not authorize a wildcard path match. Preserve rejection status.

On an already prepared Mac, the next proposed observation is **one**, not a
full CI rerun, unchanged-profile credential-free launch:

```sh
./node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --startup-only=claude
```

This command was not executed on this Linux host. Review bounded reason text
and the newly available faulting symbols from that same PID. If text is still
empty and symbols do not identify a component, stop: repeating the full suite
adds no evidence. A relevant stack supports localization, but does not by
itself justify filesystem/Mach/process allowances.

Only after independent exact-PID denial text identifies an operation and
resource should a separately reviewed diagnostic experiment vary **one exact
allowance**, compare unchanged/restricted variants, and re-run confinement
negative tests. Do not pick a Cryptex directory, Mach service, loader mapping,
process grant, or broad system profile merely from this namespace mapping.
There is currently **no conclusive evidence for any production permission
edit** and no sandbox fix is claimed.

## Local verification

Both newly added tests were observed failing before implementation. Then:

```sh
./node_modules/.bin/tsx --test tests/ai-runner.test.ts
./node_modules/.bin/tsc --noEmit
```

Result on Linux: **19/19 tests passed**, typecheck exited 0. This verifies
sanitization, bounded diagnostics, and attribution gates, not Darwin startup
or runtime confinement.
