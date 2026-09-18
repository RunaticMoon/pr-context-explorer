# Public binary releases

## Boundaries

- One public repository: `RunaticMoon/pr-context-explorer` (`private: false`, `visibility: public`). There is no separate release repository. The anonymous update feed points at this same repository.
- The publisher checks the exact repository identity and that it is public immediately before creating a release and again before promotion. It never changes visibility or migrates releases.
- Public releases contain exactly the named arm64 ZIP, DMG, and `public-mac.json`. No checkout, Git history, Actions logs, caches, user data, credentials, private configuration or source archive is uploaded beyond the repository's own published source. Executable bundled JavaScript and dependency package manifests are necessarily distributed.
- The public tag targets the exact tested source commit — the same SHA the workflow validated (`GITHUB_SHA`). GitHub's automatic source archives therefore contain that tested source tree. The manifest's `sourceCommit` records the same commit, and the release body records it as well.
- ZIP and manifest hashes protect transport/integrity, not compromise of an authorized publisher or both artifact and metadata. The client trusts the fixed GitHub HTTPS repository.

## Contract

See [PUBLIC-UPDATE-PLAN.md](PUBLIC-UPDATE-PLAN.md) for the exact schema. Generate after packaging:

```sh
python3 distribution/public-manifest.py generate release
python3 distribution/public-manifest.py verify release
```

Both commands require a stable `RELEASE_TAG`, full lowercase `GITHUB_SHA`, the exact public `GITHUB_REPOSITORY`, and matching root package version. Generation hashes the real final ZIP. Verification recomputes metadata, checks the bundle plist and packaged ASAR version snapshot, checks actual dependency inventory hashes, and audits archive paths/private-file exclusions. It permits required dependency manifests and compiled JS. It does not pretend to validate Apple identity: signature/architecture, installed GUI and bundled runtime checks run on the Mac runners.

## Required release sequence

`.github/workflows/macos-public-release.yml` is manually dispatched from `main` on the public repository for publication (`approve_public_release=true` only runs the publisher on `main`; `feat/public*` and `fix/public*` branches exercise the build gates without publishing). Supply the full reviewed commit matching dispatch `github.sha`, a **new** stable tag matching the package version, and `approve_public_release` (default false). The intended next version is `v0.6.1`; the integration owner updates root version separately.

1. **macOS 15 arm64:** version checks, dependency installation, full unit/desktop/build gates, ad-hoc packaging, unsigned checks, installed final-ZIP smoke, runtime validation, binary-only audit and public-updater acceptance.
2. Upload **only** ZIP, DMG and manifest as one immutable Actions artifact (7-day retention).
3. **macOS 26 arm64:** download that exact artifact ID with digest mismatch treated as an error. No rebuilding of the release ZIP. Verify manifest and inventory; install/smoke the final ZIP and run updater acceptance; verify again afterward.
4. **Publication:** depends on both successful Mac jobs and explicit public-publication input. A separate `public-release` environment gates the publisher job. The publish job runs with `permissions: contents: write` and receives the workflow's own token as `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`. Checkouts do not persist credentials. No publisher credential exists in build/test jobs (they assert `GH_TOKEN` is unset).
5. Publisher refuses any existing exact tag or release/draft, atomically creates a new tag at the exact released source commit, and reads that tag back (a concurrent tag creation fails rather than being reused). It creates an explicit stable **draft**, uploads only the three validated assets without clobber, reads back the release/asset identities and sizes, downloads every asset and compares all SHA-256 hashes, then promotes with explicit `draft=false`, `prerelease=false`, `make_latest=true`. It reads back the final record, tag target, and latest release.

Every release `html_url` readback must be the exact canonical `https://github.com/RunaticMoon/pr-context-explorer/releases/tag/<tag>` once published. A **draft** has no canonical tag page yet, so it may carry that canonical URL or GitHub's bounded `untagged-<hex>` path — only under the exact `https`/`github.com`/repository prefix, with no userinfo, port, query, fragment or encoding variants. (A real run was observed serving `…/releases/tag/untagged-…` for the draft; demanding the canonical URL there fails closed before any upload.)

**No resume feature.** There is no cross-repository draft/resume handshake and no `PUBLIC_RELEASE_RESUME_*` inputs. Any pre-existing tag or release for the target tag aborts before any mutation.

**Hard integration gate:** both Mac jobs execute `npm run test:public-update:mac`. This must exercise a real two-version public updater installation and rollback on the packaged app, not merely a mocked controller. The integration owner supplies that command. A missing command fails the workflow; there is no skip or success placeholder. These workflow checks have not yet been run on hosted Macs as part of this implementation.

## CI authorization and secrets

No separate publisher secret exists. Publication uses the workflow's own `GITHUB_TOKEN` (`GH_TOKEN` in the publisher step only), which the publish job requests via `permissions: contents: write`. No additional end-user or Apple secret is required for the ad-hoc channel. Never put the token into the app, renderer, updater, arguments, release notes, assets, local configuration or this documentation.

The publisher uses official `gh`, pins API operations to `--hostname github.com` and release operations to `--repo github.com/RunaticMoon/pr-context-explorer`, clears ambient host/debug/proxy/credential-config overrides via a minimal child environment, and uses a temporary empty gh configuration directory. Authentication goes only through the subprocess environment. Download redirects are handled by official gh, not a custom auth-forwarding curl invocation. Responses/stderr are captured and never echoed on failure. The publisher also scans the final ZIP's decompressed members and asset bytes for the exact injected publisher token; tests use a dedicated fake value, never real secrets.

**Configure required reviewers and branch restrictions on `public-release` before publishing.** An environment name alone is not approval or proof of configured protection. This change does not configure GitHub environment protection. The workflow token plus reviewed workflow/source and restricted dispatch rights are the authorization boundary; environment variables by themselves are not authentication.

## Failure and recovery

Validation errors include a closed, source-defined reason code and static message (for example, `PRIVATE_CONFIG_CONTENT_IN_ZIP`, `UNEXPECTED_ASAR_FILES`, `DEPENDENCY_INVENTORY_MEMBERSHIP_MISMATCH`, or `DEPENDENCY_INVENTORY_HASH_MISMATCH`). The dedicated validation exception accepts only that reviewed vocabulary. Unexpected exceptions emit only an enumerated type code (`UNEXPECTED_VALUE_ERROR`, `UNEXPECTED_KEY_ERROR`, `UNEXPECTED_FILE_NOT_FOUND`, `UNEXPECTED_BAD_ZIP_FILE`) or `UNEXPECTED_ERROR`. No exception arguments, arbitrary class names, member paths, environment values, asset bytes, subprocess output or traceback are printed. Search the code in `distribution/public-manifest.py` to locate the exact failed check; inspect build contents locally or in the build environment, never by dumping them into public release logs/assets.

- **Private/config content:** dependency packages can themselves ship `.github` workflows. These remain forbidden even inside `node_modules`; remove non-distribution support content in the producer **before** generating its dependency inventory. Do not exempt dependency directories from the audit.
- **Inventory membership/hash mismatch:** compare the packaged runtime against its generated inventory; filtering after inventory creation or changing bytes after hashing is a producer defect. Do not drop equality/hash checks or regenerate the release inventory merely to accept unexplained changes.
- **ASAR/package mismatch:** compare actual packager output and the version snapshot with the reviewed file allowlist. A Linux fixture built with `@electron/asar` checks parsing but cannot establish Mac signing, architecture or installed launch readiness.

No overwrite, automatic deletion, release reuse or tag reuse is permitted. A failure may leave a reserved tag or a draft with partial assets (or, if final readback fails after promotion, a public release). Stop and inspect the exact tag/release manually. Do not rerun expecting replacement. Resolve the leftover tag/draft manually, or bump the version for a fresh tag. Operator recovery and any deletion require a separate explicit decision. Fix the defect and prefer a fresh version/tag after the required gates.

Existing `v0.5.1` and the external manager remain separate. No token migration, visibility change or automatic conversion is attempted. Install the first public-updater DMG manually once; older builds cannot discover this channel. PR/Jira credentials are unrelated to updater authentication and remain local.

Ad-hoc signing is **not** Apple Developer ID signing or notarization. macOS may require explicit user approval in Privacy & Security. This workflow does not remove quarantine, disable Gatekeeper, change global security policy or require administrator installation. Real user-machine approval remains distinct from CI smoke results.

## Local verification (no network publication)

```sh
node --import tsx --test tests/distribution*.test.ts
bash -n distribution/publish-public.sh
python3 -m py_compile distribution/public-manifest.py
```

Public-release tests create real local ZIP/ASAR/inventory fixture bytes and replace `gh` with a recorder. They verify publication ordering, public visibility, tag-target equality with the released commit, existing tags/drafts, extra/corrupt assets, fixed host routing, strict provenance, file rejection and exact fake-token non-disclosure. Their output is **not evidence of a real upload or Mac execution**.

## Public README note — not posted by this change

The source repository is public; release tags point at the exact tested source commit. Download the latest DMG from this repository's Releases page and install the application. Releases also provide the matching ZIP and public-mac.json integrity manifest. In-app public update checks require no GitHub token.

These personal builds are ad-hoc signed, not Apple Developer ID signed or notarized. macOS may require explicit approval in Privacy & Security. Do not disable Gatekeeper or remove quarantine as a workaround.

Install the first public-update-enabled version manually. Older builds cannot automatically migrate to this channel. Your PR/Jira authentication is independent from application updates.

The release's source commit identifies the exact tested source commit; tags point at that commit. Hashes are integrity checks, not a substitute for trusting the publisher.
