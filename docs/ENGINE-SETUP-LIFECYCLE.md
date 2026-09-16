# Local engine identity and setup lifecycle

## Consent boundary

Local Codex credential reuse is session-scoped and bound to a **resolved native executable identity**, not its filename. Discovery first uses the existing native/trusted-path validation. The server then opens the canonical executable with `O_NOFOLLOW | O_NONBLOCK`, requires a regular non-group/world-writable file owned by root or the current user, and fingerprints its bytes and metadata. The identity includes canonical path, device, inode, size, nanosecond mtime/ctime, permissions, ownership and SHA-256 of the bytes. Descriptor metadata and canonical pathname metadata must still agree after hashing.

Hashing uses a 1 MiB buffer, a 1 GiB maximum file size and a 10-second work deadline checked between reads. This accommodates native Claude payloads larger than 200 MB without unbounded memory allocation. A bounded server-local cache retains hashes only while all trusted metadata matches; metadata changes force a new hash. These checks never open credential contents or query a keychain. Credential discovery remains metadata-only.

Candidate IDs are random opaque per-provider, per-session handles, retained only while the identity is unchanged. Browser responses contain neither the executable identity nor filesystem metadata, executable paths or credential paths. Both atomic same-path replacement and same-size in-place updates reset consent and require a new candidate ID. A stale candidate cannot grant consent. Auth metadata checks finish **before** the final executable revalidation; a concurrent change results in a generic error.

Authenticated status probing revalidates the selected identity before credential preparation and again before invoking the isolated status command. `resolveConfig` revalidates before returning auth configuration. A post-probe identity check prevents obsolete ready results from being published. Readiness requires the current installation, authorized auth configuration, supported capabilities, authenticated status and runtime-verified isolation; consent alone is not readiness. No setup method performs inference.

### Trusted-local mutation limit

This is not protection against a privileged attacker forging filesystem metadata, nor an atomic execution guarantee. The metadata-keyed hash cache assumes trustworthy kernel metadata (in particular ctime) and ordinary local filesystem semantics. A concurrent same-user updater can still change a pathname after the last check and before the sandbox executes it. Eliminating that final pathname TOCTOU window requires execution from a pinned descriptor or an immutable verified snapshot integrated with each platform's sandbox/signature policy. Neither is claimed here. Path/metadata and byte checks detect updates across checks, including updates during hashing; they do not freeze the filesystem. A blocked kernel filesystem read cannot be forcibly interrupted by JavaScript's between-read work deadline.

## Lifecycle

`createEngineSetupService().close(): void` is synchronous and idempotent. It aborts the service controller, revokes/clears selected consent, clears cached status and releases its base auth configuration reference. Pending API-facing promises reject immediately with `AIError("cancelled")`, including dependency injections that fail to cooperate with cancellation. Every future status, refresh, consent or resolve request also rejects. A late dependency completion cannot publish readiness or restore consent.

Status/refresh/consent/config operations share a serial queue. This provides a single ordered state history instead of allowing overlapping global scans to commit obsolete generations. Explicit refreshes run in order; cached status reads run after prior operations. Revocation and closure cannot be overwritten by a stale concurrent scan.

The controller's `AbortSignal` propagates through `probeProviders`, credential-free CLI probes, sandbox preflight and isolated auth-status subprocesses. Abort is surfaced as cancellation rather than an unavailable/fallback provider result. The process runner owns bounded termination/reaping; setup close does not synchronously wait for OS child exit. Scratch cleanup remains in the existing probe finalizers. LiveAPI's existing optional engine-setup close hook invokes this lifecycle; no per-view model state or alternate inference path is introduced.

## Verification scope

Linux regressions cover real copies of `/usr/bin/true` and `/usr/bin/false` replaced at the same path, an in-place same-size write, unchanged refresh stability, asynchronous consent mutation, overlapping refreshes, late readiness, closure during consent and a deliberately non-cooperative pending probe. A locally compiled native C streaming fixture starts all fixed credential-free CLI probes; tests record their actual PIDs and verify they are reaped after close. Pre-aborted provider probes reject without fallback.

These tests exercise Linux native execution. They are **not** evidence of macOS signing, Seatbelt or packaged Apple Silicon execution; those platform checks remain pending on macOS hardware. Server-only dependency injection is explicit in unit tests and cannot be configured through browser JSON.
