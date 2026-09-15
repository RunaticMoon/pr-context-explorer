# macOS crash identity: evidence, not attribution

## Observed evidence

Local artifact `artifacts/github-job-104268243253.log` from run
`34934108801` contains PID-matching, executable-mismatching rejections:

| Target | Launch delta (ms) | Capture delta (ms) | IPS bytes |
| ------ | ----------------: | -----------------: | --------: |
| node   |                 9 |                 18 |      6720 |
| codex  |                10 |                 31 |      6728 |
| claude |                 6 |                 21 |      6804 |

These deltas already fit the existing one-second clock tolerance. Repeated
reads are not independent reports. The artifact does **not** contain the
reported `procPath`, its type/presence, or the native exception/termination
fields. No `.ips` payload was available in this checkout. Consequently,
Apple path anonymization, a missing/malformed path, and a genuinely different
executable remain hypotheses. The regression's Apple-style two-object IPS
is synthetic, not a recovered CI fixture. The actual mismatch and abort cause
cannot yet be identified from this log alone.

## Minimal diagnostic change

The verified summary still requires exact PID, exact full executable path,
and both valid timestamps within the unchanged tolerance. No wildcard,
basename, or redacted-path matching is accepted. Production sandbox policy,
CLI launch, and permissions are untouched.

A rejected report with matching PID **and both timestamps** can now emit:

- `reportedIdentity.procPath`: at most 256 characters, control characters
  removed and a `/Users/<account>/` prefix replaced with `/Users/USER/`.
- `pathHasRedactionMarker`: whether the original value contained `*` or
  started with `/Users/USER/`, measured before diagnostic sanitization.
  This is a lexical observation, not proof of Apple redaction or identity.
- `fieldTypes`: a fixed field-name allowlist with types including `missing`
  and `null`, plus a numeric report-type string from body or optional header.
- `hypothesis.status: "unverified-executable-match"` with allowlisted,
  bounded exception/termination fields. These are candidate assertions,
  **not a verified target crash report**. They do not increment the matched
  count or produce a `fresh-crash-summary`.

Wrong PID, invalid/stale/out-of-window timestamps expose only rejection
booleans/deltas, not diagnostic text. Existing file freshness, no-follow,
2 MiB read cap, 24-read limit, and bounded search remain intact. No raw
report, environment, register/thread state, memory map, or command line is
included. Allowlisted native reason strings are not a general-purpose secret
scrubber: keep this credential-free and review output before sharing.

## Next real-Mac check

On the prepared Darwin arm64 checkout, with existing trusted CLI installation:

```sh
./node_modules/.bin/tsx scripts/macos-ai-diagnostics.ts --startup-only=claude
```

This performs one credential-free startup using the unchanged production
profile, skips the additional confinement/capability launches, and collects
bounded evidence from the same host PID. A failing exit is expected while
startup still aborts. Review the JSON `claude-crash-candidate-rejected`
records and their explicit unverified status; keep sanitized identity and
allowlisted exception/termination evidence, not raw IPS or credentials.

If the path is redacted, do not convert it to an exact match. A future
verified fallback would require independently reading the trusted binary's
actual Mach-O UUID and validating the corresponding report image identity;
this patch neither guesses UUID formats nor trusts a report's own UUID as
independent evidence. If termination reason is missing, that is not evidence
of no sandbox denial and not justification for broad permissions. Linux
regressions verify parsing and attribution rules, not a Darwin abort cause.

## Local regression command

```sh
./node_modules/.bin/tsx --test tests/ai-runner.test.ts
./node_modules/.bin/tsc --noEmit
```
