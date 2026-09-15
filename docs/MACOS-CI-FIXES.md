# Actual macOS CI failure follow-up

## Evidence and fixes

RED evidence: `artifacts/github-job-104249916708.log`, job 104249916708 / run 34927954142, macOS 15.7.9 (24G830), ARM64, Node 24.

- Lines 1047–1075: auth fixtures used `/tmp/...`; `readPrivate` deliberately requires a canonical path. Canonicalize newly created, test-owned fixture roots instead of weakening the credential path boundary. A regression explicitly rejects a user-controlled parent symlink even for a valid private key file.
- Lines 1077–1099 and 1184–1209: child cwd becomes `/private/tmp/...`, unlike the old expected `/tmp/...`. Canonicalize owned launcher/runner fixtures and production per-run scratch roots immediately after `mkdtemp`, before constructing auth/schema paths or environments.
- Lines 1192–1205: Darwin inserts `__CF_USER_TEXT_ENCODING` after exec. Permit only that single field, only on Darwin, with its numeric triplet format validated. Exact equality still rejects all other unexpected environment entries.
- Lines 1211–1228: a Linux bwrap test expected `linux-bwrap` on Darwin. The two bwrap-specific tests now explicitly run only on Linux; the six existing real Darwin tests retain their original mandatory Darwin conditions. The generic failure-gate tests supply both a missing bwrap and a missing standalone Node, so a working Mac boundary cannot accidentally invalidate those negative fixtures.
- A runner cleanup assertion previously accepted `/proc` ENOENT on Darwin as proof of death. Darwin now polls the actual PID for ESRCH instead.

## Seatbelt startup: not yet resolved or claimed green

Lines 1102–1182 show startup failures: fake Node exits 65 immediately, TLS exits 65, timeout never reaches its deadline, and both discovered pinned native CLI payloads fail their capability commands. The old errors discarded stderr. Exit 65 is consistent with SBPL compilation/setup failure, but this log does not identify a failing form. Runtime read/IPC or dyld denials are separate hypotheses; adding privileges without the actual error would not establish a cause.

Static research confirmed that `path-ancestors` is an existing SBPL filter, not an obviously invented helper (Chromium's macOS policy documents its introduction in 10.14). Existing upstream sandbox-runtime profiles also use `sysctl-name-prefix`. These facts do **not** prove that our complete profile compiles on the failing OS. No speculative policy permission changes were made.

The next real Mac run must capture the actual compiler/dyld error before deciding whether a syntax compatibility fix or a specifically audited standard-runtime access is necessary. In particular, do not import broad system profiles, allow arbitrary network/IPC, permit fork, grant home/source reads, or disable Gatekeeper/sandbox checks to obtain startup.

## Exact next command (real Mac, after pinned CLI installation)

```sh
node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts
```

The script prints JSON records containing:

- OS/architecture/Node identity, never the parent environment;
- exact path/realpath/ownership/mode metadata for the executable ancestors, system aliases, sandbox-exec and CA file;
- the exact generated deny-default profile and a numbered equivalent for standalone Node and each discovered native CLI;
- exit codes, bounded stdout/stderr from fixed synthetic Node startup and native `--version`;
- the full real confinement probe and credential-free CLI help/version/feature/status results.

It reads no server settings or credential files, passes no auth, sends no inference/API request, changes no policy, and exits nonzero on missing prerequisites, confinement failure, or unsupported CLI capabilities. A Linux invocation deliberately reports unsupported and exits 1, never runtime-verified. JSON encoding prevents raw terminal controls/workflow-command lines from being emitted by child stderr.

Then run:

```sh
node_modules/.bin/tsx --test tests/ai*.test.ts
```

Failure assertions now retain credential-free stderr (including early timeout exits and exact CLI commands), while authenticated analysis still has no raw-output diagnostic hook. The fake confinement probe exposes a bounded startup error only from its fixed script and synthetic auth.

## Local verification

Linux ARM64 / Node v24.20.0: TypeScript checking passed; AI tests passed (130 passed, six Darwin-only tests skipped, no failures). The diagnostic script exercised its non-Darwin fail-closed branch. This is **not** macOS runtime verification. Parent must rerun the real Mac job; exit 65 remains an explicit blocker until that evidence is available.
