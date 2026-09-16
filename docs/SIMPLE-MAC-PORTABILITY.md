# Simple connection fixture portability

## Cause and boundary

The new session-auth, GitHub simple onboarding, Jira onboarding and credential-lifecycle fixtures passed the lexical result of `mkdtemp` to strict store/native-executable checks. macOS system temporary roots can include `/var` or `/tmp` aliases. The fixture directory was private and owned by the test, but its lexical parents included a symlink, correctly triggering `unsafe store directory` (and native identity rejection).

Resolve **only the directory just created by the test** with `realpath(mkdtemp(...))`, before deriving store, native executable or session scratch paths. Do not resolve supplied settings/store/executable paths, or the malicious links deliberately constructed by security tests. No production code, auth validation, sandbox checks, CI timeouts or platform skips change here.

The first full aliased run exposed the apparent CI hang in `jira-onboarding-tls.test.ts`: it opened an HTTPS listener, then constructed `LocalStore` **before** entering its cleanup `try/finally`. The constructor rejected the alias and the listening server kept the worker alive. The HTTPS credential-revocation fixture had the same cleanup ordering. Both now cover listener startup and store/bridge construction with cleanup; sessions are closed and active server connections destroyed on failure. Owned temp cleanup is also registered before native tools/constructors where applicable.

Paused engine tests now always release their gates in `finally`. `wait-for-fixture.ts` bounds gate observation and can detect an operation failing/finishing before its gate without leaking rejection details. Its regression covers early rejection, early completion, missing gate and successful arrival.

## Permanent regression

`tests/tmpdir-portability.test.ts` creates a canonical private scratch directory and a temporary symlink alias. It starts a separate runner with `TMPDIR`, `TMP` and `TEMP` pointing at that alias and **deletes `NODE_TEST_CONTEXT`** so child tests really execute.

The child runs the existing store/settings/desktop tests plus:

- `engine-session-auth.test.ts`
- `engine-setup.test.ts`
- `github-simple.test.ts`
- `jira-onboarding-routes.test.ts`
- `jira-onboarding-tls.test.ts`
- `simple-credential-lifecycle.test.ts`
- `simple-setup-integration.test.ts`

It requires exit zero and explicit unskipped TAP case names, including HTTP onboarding and paused shutdown. Reporter/concurrency options precede positional test files (Node can otherwise ignore the reporter option). The existing 30-second child deadline is retained; failure kills the owned runner process group rather than leaving worker listeners behind. Two child workers avoid paying all independent fixture startup costs serially. Existing malicious-symlink assertions execute unchanged.

Run the permanent regression with:

```sh
node --import tsx --test --test-reporter=tap tests/tmpdir-portability.test.ts tests/fixture-lifecycle.test.ts
```

For a complete alias run on a POSIX host, make a fresh directory, create a directory symlink pointing to it, set all three temporary-directory variables to the alias, unset `NODE_TEST_CONTEXT`, and run:

```sh
node --import tsx --test --test-concurrency=4 --test-reporter=tap tests/*.test.ts
```

Use a 120-second external deadline and capture TAP; kill only that owned test process group on timeout. Do not exclude security tests. The local reproduction harness is `/home/ubuntu/.hermes/cache/prce-alias-suite.py` (not a shipped application dependency).

## Verified Linux evidence

- Original parent three-file alias reproduction: **7 passed, 0 failed, 0 skipped** (`artifacts/simple-mac-alias-repro.log`).
- Full normal `npm test`: **719 tests, 709 passed, 10 existing skips, 0 failures** (`artifacts/simple-full-normal-verified.log`).
- Full aliased temporary-root suite, with four file workers and the external 120-second deadline: **719 tests, 709 passed, 10 existing skips, 0 failures** (`artifacts/simple-full-alias-verified.log`). No files excluded.
- `npm run build` (TypeScript no-emit check plus Vite production build): passed (`artifacts/simple-portability-build.log`).

The expanded regression was observed red before fixture corrections (`artifacts/simple-alias-red.log`); the full red trace identifies the open HTTPS fixture (`artifacts/simple-full-alias-red.log`). Later serial/low-concurrency attempts hit the local 120-second budget while still making progress, not at the original leaked listener. Individual last-worker verification passed (`artifacts/simple-last-worker-alias-green.log`). The final normal serial suite took about 138 seconds; the final successful four-worker alias run took about 104 seconds. Neither observation changes the CI timeout.

These are Linux alias/loopback fixtures, not an actual macOS rerun, live provider authentication, or model inference. Actual macOS CI remains the parent's verification step.
