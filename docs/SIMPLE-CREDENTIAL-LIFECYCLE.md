# Credential lifecycle boundaries

## Guarantees

- `LiveAPI.close()` aborts pending GitHub PAT onboarding, deletes provisional and registered session credentials, and rejects subsequent mutating API calls. A transport that ignores cancellation cannot delay the onboarding rejection or register/persist a late result. A second check immediately before persistence covers the promise-continuation race.
- Existing connection metadata is preserved at shutdown; credentials become required rather than silently changing cache identity. Shutdown is instance-scoped: another API instance's accounts remain usable.
- Jira callback credentials are resolved for every read, not cached as reusable Authorization headers. Session bindings carry a process-only, per-connection revocation signal. Settings deletion, replacement/reconnect, and shutdown abort already-bound read sessions, including response waits. Unrelated hosts are not revoked by a connection-specific operation.
- A request already sent before revocation cannot be unsent. The guarantee is cancellation of local pending work and no later request using the revoked binding. Errors remain fixed, credential-free failure states; cancellation is not successful capture.
- SourceBridge rejects writes after shutdown and checks shutdown again after asynchronous onboarding, before saving metadata.
- LiveAPI pipeline-cache writes check both job cancellation and API lifetime, preventing a paused executor from writing chunks after shutdown. Existing final-result checks still prevent cancelled jobs from completing or saving analysis.

## Compatible interfaces

- `connectGitHub(body, client, signal?)` adds an optional AbortSignal. Existing two-argument callers remain valid.
- Trusted Jira callback credentials may supply `signal?: AbortSignal`. It is not a browser JSON setting and is never persisted. Existing environment credentials and callbacks without signals continue to work.
- Engine setup injection still permits an optional `close()` method (`Omit<ReturnType<...>, "close">` plus optional close), preserving older test/server seams.
- No HTTP endpoint, Origin/CSRF gate, TLS verification, redirect policy, PAT storage format, or browser behavior changed.

## Regression evidence

`tests/simple-credential-lifecycle.test.ts` contains eight lifecycle tests using real LiveAPI/SourceBridge/LocalStore/JiraReadSession implementations, paused upstream transports, a real HTTPS loopback Jira fixture with a test CA, and a paused executor. Red tests reproduced pending GitHub onboarding after close, all three Jira cached-header lifecycle failures, SourceBridge post-close writes, and post-close pipeline-cache writes before their respective fixes.

Verification:

```sh
./node_modules/.bin/tsx --test tests/simple-credential-lifecycle.test.ts
./node_modules/.bin/tsc --noEmit
npm test
git diff --check
```

Final verification: lifecycle 8 passed; complete Node suite 702 passed, 10 skipped, 0 failed (712 tests); TypeScript and diff checks passed. Full-suite log: `/tmp/credential-lifecycle-final-test.log`.

The original independent `/home/ubuntu/review-simple-setup/review.ts` was preserved and rerun: GitHub onboarding rejected and Jira's formerly successful post-forget read now rejected as cancelled. A copy, `review-fixed-lifecycle.ts`, changes only that Jira read to expect rejection so the script can continue. Its output confirms `authorizationSentAfterForget:false`; the independently implemented engine replacement case also reports `candidateIdUnchanged:false` and `authStillWired:false`.

No real credentials, remote GitHub/Jira accounts, or model calls were used. UI/E2E integration is verified separately by the parent integration task.
