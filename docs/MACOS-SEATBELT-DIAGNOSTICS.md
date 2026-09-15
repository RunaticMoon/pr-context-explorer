# macOS Seatbelt diagnostics (credential-free)

## Confirmed compiler defect, not a runtime success claim

Actual Mac CI run `34929263480`, job `104253850272`, recorded exit 65:

```text
sandbox-exec: host must be * or localhost in network address
(remote tcp "127.0.0.1:49186")
```

The profile now uses `(remote tcp "localhost:<exact-port>")`. There is no wildcard host/port, external network grant, inbound allowance, DNS or Unix-socket permission. The host relay binds **both `127.0.0.1` and `::1` at the same port** before returning it, using an IPv6-only socket for `::1`. If either bind fails (including disabled IPv6 or a collision), it closes the partial relay and Unix gateway and fails closed. Both families share connection/transfer limits and the existing exact CONNECT authority/public-IP gateway. Neither family may reach an unrelated same-port listener.

Linux regression tests first failed on the old profile text, an unreserved IPv6 port, and missing SIGTERM evidence; they now pass. This does **not** compile SBPL or verify Seatbelt on Linux. The actual Darwin confinement probe now requires denied live IPv4 **and IPv6** non-proxy listeners and gateway `403 Forbidden` responses through both proxy families. Timeout/refusal is still not accepted as denial.

## Remaining unknown: immediate native startup termination

The same Mac job showed Node, Codex and Claude no-network startup returning `exitCode: null` with no stdout/stderr. That does not establish why the OS killed them. `ProcessResult.terminationSignal` now preserves the native close-event signal when present; ordinary exits retain their old result shape. A real credential-free Node process self-terminating with SIGTERM verifies this on Linux. Existing timeout/cancellation error behavior and process-group cleanup are unchanged.

No new file, dyld, process, Mach-service or syscall grants have been added. In particular, `(deny process-fork)` remains. Cryptex dyld paths, initial exec/fork enforcement and signing/runtime failures remain hypotheses, not established causes.

## Next actual Apple Silicon command

From the project root on the actual Darwin arm64 runner with the pinned native CLIs installed:

```sh
./node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts
./node_modules/.bin/tsx --test tests/ai*.test.ts
```

Run the second command even if the first fails; the diagnostics deliberately return nonzero for unresolved startup/confinement/capability failures. The parent agent owns the CI rerun. No actual Mac success is claimed by this patch.

The diagnostic script:

- Runs the original exact no-network production profile with a fake Node scratch-writing script or CLI `--version`, private HOME/cwd and no auth.
- Separately repeats that credential-free startup with **only** `(deny default)` changed to `(deny default (with report))`. It reports the exact profile, PID, exit status and termination signal. This mode exists only in the diagnostic script, not in the inference API. The synchronous reproduction has a 10-second timeout, SIGKILL and 64-KiB output bound; fork remains denied.
- Queries `/usr/bin/log show --last 2m --style ndjson --info --debug` using only sandbox/crash/signature service producers and delimited references to that exact fake-launch PID. The query is capped at 10 seconds, 64 KiB stdout and 4 KiB stderr. Errors/limits are reported, not replaced by synthetic evidence. Empty or delayed unified logs are inconclusive, not proof that no denial occurred. It does not read personal DiagnosticReports or broad process-name history, elevate privileges, or dump environment variables.
- Reports metadata and resolved ancestry for `/usr/lib/dyld`, `/System/Library/dyld`, `/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld`, and `/System/Cryptexes/OS/System/Library/dyld`. Up to 24 matching shared-cache entry names receive metadata inspection. This is ownership/mode/symlink evidence, **not** file contents or proof of sealed-volume integrity; no permission is granted based on existence alone.
- JSON-escapes every output record, including profiles and bounded OS log text. No original credentials, source files, personal accounts, TLS disabling or sandbox bypass are involved.

Review actual signal + denial/crash messages + runtime metadata before proposing a narrowly scoped change. Any change to the initial process-launch boundary needs independent security review, not an `allow process*` workaround.
