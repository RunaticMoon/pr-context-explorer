# Public binary releases

## Boundaries

- Development source stays **private** at `RunaticMoon/pr-context-explorer`.
- Public installers live only at `RunaticMoon/pr-context-explorer-releases`. The publisher checks both repository identities and visibility immediately before creating a release and again before promotion. It never changes visibility or migrates private releases.
- Public releases contain exactly the named arm64 ZIP, DMG, and `public-mac.json`. No checkout, Git history, Actions logs, caches, user data, credentials, private configuration or source archive is uploaded. Executable bundled JavaScript and dependency package manifests are necessarily distributed and are not source secrecy guarantees.
- The public tag targets the exact SHA read from **public `main`**, whose tree must contain only `README.md`. GitHub's automatic source archives therefore contain that public README, not private development source. The manifest's `sourceCommit` records the private build's `GITHUB_SHA`; it is **not** the public tag target. The release body records the same provenance.
- ZIP and manifest hashes protect transport/integrity, not compromise of an authorized publisher or both artifact and metadata. The client trusts the fixed GitHub HTTPS repository.

## Contract

See [PUBLIC-UPDATE-PLAN.md](PUBLIC-UPDATE-PLAN.md) for the exact schema. Generate after packaging:

```sh
python3 distribution/public-manifest.py generate release
python3 distribution/public-manifest.py verify release
```

Both commands require a stable `RELEASE_TAG`, full lowercase `GITHUB_SHA`, the exact private `GITHUB_REPOSITORY`, and matching root package version. Generation hashes the real final ZIP. Verification recomputes metadata, checks the bundle plist and packaged ASAR version snapshot, checks actual dependency inventory hashes, and audits archive paths/private-file exclusions. It permits required dependency manifests and compiled JS. It does not pretend to validate Apple identity: signature/architecture, installed GUI and bundled runtime checks run on the Mac runners.

## Required release sequence

`.github/workflows/macos-public-release.yml` is manually dispatched from `main` or `feat/public-updates` on the private repository. Supply the full reviewed commit matching dispatch `github.sha`, a **new** stable tag matching the package version, and `approve_public_release` (default false). The intended first version is `v0.6.0`; the integration owner updates root version separately.

1. **macOS 15 arm64:** version checks, dependency installation, full unit/desktop/build gates, ad-hoc packaging, unsigned checks, installed final-ZIP smoke, runtime validation, binary-only audit and public-updater acceptance.
2. Upload **only** ZIP, DMG and manifest as one immutable private Actions artifact (7-day retention).
3. **macOS 26 arm64:** download that exact artifact ID with digest mismatch treated as an error. No rebuilding of the release ZIP. Verify manifest and inventory; install/smoke the final ZIP and run updater acceptance; verify again afterward.
4. **Publication:** depends on both successful Mac jobs and explicit public-publication input. A separate `public-release` environment gates the publisher job. Contents permission for the source `GITHUB_TOKEN` remains read-only; checkouts do not persist credentials. Only the final publisher step receives `PUBLIC_RELEASE_TOKEN`.
5. Publisher refuses any existing exact tag or release/draft, atomically creates a new public tag at the verified README commit, and reads that tag back (a concurrent tag creation fails rather than being reused). It creates an explicit stable **draft**, uploads only the three validated assets without clobber, reads back the release/asset identities and sizes, downloads every asset and compares all SHA-256 hashes, then promotes with explicit `draft=false`, `prerelease=false`, `make_latest=true`. It reads back the final record, public tag target, and latest release.

**Hard integration gate:** both Mac jobs execute `npm run test:public-update:mac`. This must exercise a real two-version public updater installation and rollback on the packaged app, not merely a mocked controller. The integration owner supplies that command. A missing command fails the workflow; there is no skip or success placeholder. These workflow checks have not yet been run on hosted Macs as part of this implementation.

## CI authorization and secrets

`PUBLIC_RELEASE_TOKEN` is already registered as an encrypted secret in the private repository. No additional end-user or Apple secret is required for the ad-hoc channel. It needs private-source metadata read access and public-distribution release/content write access. The currently configured user PAT may have broader repository/secret permissions: keep it confined to this reviewed CI step and consider narrowing/replacing it independently. Never put it into the app, renderer, updater, arguments, release notes, assets, local configuration or this documentation.

The publisher uses official `gh`, pins API operations to `--hostname github.com` and release operations to `--repo github.com/RunaticMoon/pr-context-explorer-releases`, clears ambient host/debug/proxy/credential-config overrides via a minimal child environment, and uses a temporary empty gh configuration directory. Authentication goes only through the subprocess environment. Download redirects are handled by official gh, not a custom auth-forwarding curl invocation. Responses/stderr are captured and never echoed on failure. The publisher also scans the final ZIP's decompressed members and asset bytes for the exact injected publisher token; tests use a dedicated fake value, never real secrets.

**Configure required reviewers and branch restrictions on `public-release` before publishing.** An environment name alone is not approval or proof of configured protection. This change does not configure GitHub environment protection. The private repository secret plus reviewed workflow/source and restricted dispatch rights are the authorization boundary; environment variables by themselves are not authentication.

## Failure and recovery

No overwrite, automatic deletion, release reuse or tag reuse is permitted. A failure may leave a reserved public tag or a draft with partial assets (or, if final readback fails after promotion, a public release). Stop and inspect the exact tag/release manually. Do not rerun expecting replacement. Operator recovery and any deletion require a separate explicit decision. Fix the defect and prefer a fresh version/tag after the required gates.

Existing private `v0.5.1` and the private external manager remain separate. No token migration, visibility change or automatic conversion is attempted. Install the first public-updater DMG manually once; older builds cannot discover this channel. PR/Jira credentials are unrelated to updater authentication and remain local.

Ad-hoc signing is **not** Apple Developer ID signing or notarization. macOS may require explicit user approval in Privacy & Security. This workflow does not remove quarantine, disable Gatekeeper, change global security policy or require administrator installation. Real user-machine approval remains distinct from CI smoke results.

## Local verification (no network publication)

```sh
node --import tsx --test tests/distribution*.test.ts
bash -n distribution/publish-public.sh
python3 -m py_compile distribution/public-manifest.py
```

Public-release tests create real local ZIP/ASAR/inventory fixture bytes and replace `gh` with a recorder. They verify publication ordering, wrong visibility, existing tags/drafts, extra/corrupt assets, fixed host routing, strict provenance, private-file rejection and exact fake-token non-disclosure. Their output is **not evidence of a real upload or Mac execution**.

## Public README template — not posted by this change

```markdown
# PR Context Explorer — macOS downloads

Binary-only downloads for PR Context Explorer on Apple Silicon.
Development source is private; this repository does not contain it.

Download the latest DMG from this repository's Releases page and install the
application. Releases also provide the matching ZIP and public-mac.json integrity
manifest. In-app public update checks require no GitHub token.

These personal builds are ad-hoc signed, not Apple Developer ID signed or
notarized. macOS may require explicit approval in Privacy & Security. Do not
disable Gatekeeper or remove quarantine as a workaround.

Install the first public-update-enabled version manually. Older private builds
cannot automatically migrate to this channel. Your PR/Jira authentication is
independent from application updates.

The release's source commit identifies private-build provenance; public tags
point to this README-only distribution repository. Hashes are integrity checks,
not a substitute for trusting the publisher.
```
