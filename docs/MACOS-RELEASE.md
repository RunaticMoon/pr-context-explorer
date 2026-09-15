# Private Apple Silicon distribution

## Default: personal unsigned/ad-hoc app + external manager

No Apple Developer Program membership is required for this path. It does **not** provide Developer ID identity, Apple notarization, or a signed Electron/Squirrel updater. macOS can block first launch; review the app/source and use the OS's per-app approval in Privacy & Security if available. Organizational policy can prohibit approval. Nothing here removes quarantine or disables Gatekeeper.

Repository stays **private**: `RunaticMoon/pr-context-explorer`. There is no npm public publish, public tap, embedded publisher PAT, or billing modification.

### Install the manager and app

On your Apple Silicon Mac (not on the Linux/OCI server):

```sh
brew install gh python   # optional dependency convenience; Python 3.11+ required
# Authenticate as yourself; access to this private repository is required.
gh auth login --hostname github.com

# From a reviewed private checkout (no public registry required):
python3 distribution/prce install --tag v0.4.0
python3 distribution/prce check
python3 distribution/prce update
```

`v0.4.0` is an example; it must have a published personal release. Before that, the command correctly fails. The CLI is `distribution/prce`, suitable for a root npm `bin` entry `{ "prce": "distribution/prce" }`. Once integrated and committed, installing the manager from a reviewed private Git commit is possible:

```sh
# Git SSH authentication must already grant access. Replace REVIEWED_COMMIT_SHA.
npm install --global 'git+ssh://git@github.com/RunaticMoon/pr-context-explorer.git#REVIEWED_COMMIT_SHA'
prce install --tag v0.4.0
prce check
prce update --tag v0.4.1
```

The root package must include `distribution/prce` in its packed files and define that `bin`; distribution does not edit the other agent's root package. No manager self-update is performed: review/pin a new Git commit to update the manager itself. Keep the manager path stable when scheduling it.

The app is installed in `~/Applications/PR Context Explorer.app`, with no administrator rights. `install` refuses an existing app; `update` refuses missing installations and version downgrades. Updates select the highest stable release containing `personal-mac.json`, not GitHub's latest-release flag. `--tag` pins a particular stable version. Existing user data under Application Support is never removed or migrated by this tool.

### Opt-in scheduling

```sh
prce auto-update enable
prce auto-update disable
```

Enabling explicitly creates and loads only your `~/Library/LaunchAgents/com.runaticmoon.pr-context-explorer.updater.plist`: a six-hour interval, no RunAtLoad, no automatic app launch, no credentials in plist/arguments. This action is **not** run during npm install, app install, CI, or on the OCI host. `gh` must have usable noninteractive user authentication. Disable the agent before moving/uninstalling/upgrading its interpreter or the manager path; re-enable afterward. LaunchAgent operational errors can be inspected with `launchctl print gui/$(id -u)/com.runaticmoon.pr-context-explorer.updater`.

The manager defers an update if app processes are observed, checks again immediately before swap, and never kills them or interrupts analysis. Do not launch the app while installation is in progress: process inspection is not a kernel-enforced launch lock, so a concurrent launch remains a small race. Manager invocations are serialized with a per-user file lock. Staging is on the same volume as the destination; rename/backup restores the previous bundle on validation or swap errors. A machine crash/power loss between renames can leave `.prce-backup-*.app` in `~/Applications`; quit the app and manually restore that bundle rather than deleting user data. This is not a transactional filesystem or a forced in-app updater.

### Trust and validation

- All lookups/downloads use `gh` with the fixed repository above. No URL token, publisher credential, or token copied into app/config/launchAgent.
- The selected published stable tag resolves through GitHub's tag API to a commit. Manifest schema, `personal-unsigned` channel, repository, tag, commit, exact asset filename, byte size, and SHA-256 must match.
- ZIP entries must stay inside the expected app; traversal, symlink escapes, links used as extraction parents, special files, and duplicate/case-colliding members are rejected. Resource/entry limits apply. AppleDouble entries are discarded rather than extracted.
- App version, executable permission, arm64-only Mach-O, and intact local/ad-hoc code signature are checked before and after staging. Ad-hoc code signing is integrity checking, **not Apple publisher identity**.
- These checks trust the authenticated private repository and its authorized release writers. An attacker controlling that repository can replace both a binary and its manifest. GitHub tag/source binding is not an independent build attestation or Apple trust proof.
- The manager validates bundle integrity, not successful interactive startup. It does not self-update or run remote installer scripts.

## Workflows

| Workflow | Trigger | Output | Apple account |
|---|---|---|---|
| `macos-unsigned.yml` | scoped feature-branch push or manual main/feature dispatch | private Actions DMG/ZIP artifacts, 7-day retention | No |
| `macos-personal-release.yml` | manual approved exact commit + new version tag | draft, optionally published **personal unsigned** private release | No |
| `macos-release.yml` | manual exact reviewed **main** commit | optional signed/notarized draft then private production updater release | Yes; optional only |

All run `macos-15`, assert `uname -m = arm64`, use locked `npm ci`, regression/desktop tests, and publish-never builds. The official [runner reference](https://docs.github.com/actions/reference/runners/github-hosted-runners) lists macos-15 as arm64, 3 M1 cores/7 GB for private repositories. Hosted private builds consume the account's included minutes and can incur charges; availability and budget are operator gates, not a promise of free execution.

Personal release additionally executes the compiled backend smoke test and the real Mac external manager extraction, codesign/lipo verification, and staged installation path against the built app in a temporary directory. This does not substitute for interactive GUI/Gatekeeper approval or actual two-version update testing on your Mac.

### Configure before dispatch

1. Review and push the workflows/code. Updating workflows needs the appropriate **Workflows write** permission (classic PAT: `workflow` scope alongside private repo access); dispatching needs **Actions write**. Default workflow token is Contents read; only protected release jobs request Contents write. Current permissions must be checked by the parent/operator; they were not checked or changed by this implementation.
2. Create environment `personal-release`. Restrict deployment branches to `main` and, during bootstrap only, `feat/apple-silicon-desktop`; require approval/reviewer protection if your private repository's GitHub plan supports it. Remove the feature branch after merge. Without configured environment rules, the YAML environment name alone is **not** an approval boundary. Use repository/branch write restrictions and a trusted single operator where reviewer protection is unavailable.
3. Verify `package.json` version matches a NEW stable tag. There must be no existing tag/release with that name. Review the full commit that will run dependency scripts and build tooling.
4. The workflow dispatch `commit` must equal the branch's dispatch SHA. It is not an arbitrary build-source override. No PR-triggered release, `pull_request_target`, untrusted artifact handoff, or checkout of user-supplied refs exists.

```sh
# Examples only: obtain a reviewed exact SHA with git rev-parse HEAD.
gh workflow run macos-unsigned.yml --ref feat/apple-silicon-desktop

gh workflow run macos-personal-release.yml \
  --ref feat/apple-silicon-desktop \
  -f commit=REVIEWED_FULL_40_HEX_SHA -f tag=v0.4.0 -f promote=true

gh run list --workflow macos-personal-release.yml --limit 5
gh run view RUN_ID --log-failed
```

The default `promote=false` leaves a draft (the manager ignores drafts). `promote=true` still creates a draft first, uploads only ZIP/DMG/`personal-mac.json`, downloads all uploaded bytes, compares them to the verified local assets, checks exact asset count, then publishes with `--latest=false`. No `latest-mac.yml`, blockmap, or signed updater feed is uploaded. Signed updater clients must additionally reject personal releases without signed metadata; GitHub's `latest` flag alone is not a security/channel boundary.

### Reruns and recovery

No asset is overwritten and no published tag is reused. A failed upload/readback/promotion leaves a draft and blocks rerunning against that existing tag. An operator must inspect the failed run, draft, and tag; either delete the failed **unpublished** draft/tag deliberately and rebuild, or use a new version/tag. Never delete/replace a tag that was installed by clients. Do not blindly rerun the whole workflow to promote an existing draft. To promote a deliberately staged draft later, first download and compare it against that verified run's assets/manifest, then explicitly publish via GitHub/`gh release edit --draft=false --latest=false`; this is a separate operator action, not silently performed here.

## Optional future Developer ID channel

Not needed for the default personal workflow, and currently blocked without an Apple account/certificate.

Create a separate `macos-release` protected environment restricted to reviewed `main`, requiring an authorized approver where supported. Set only these environment secrets through GitHub's secret UI/secure stdin, never in a command-line literal or committed file:

| Setting | Meaning |
|---|---|
| `APPLE_CSC_LINK` secret | Base64-encoded Developer ID Application `.p12` (not an untrusted remote URL) |
| `APPLE_CSC_KEY_PASSWORD` secret | Nonempty export password |
| `APPLE_API_KEY_BASE64` secret | Base64 App Store Connect notarization `.p8` key |
| `APPLE_API_KEY_ID` secret | Apple API key ID |
| `APPLE_API_ISSUER` secret | API issuer UUID |
| `APPLE_TEAM_ID` environment variable | Stable 10-character Team ID; public identity anchor |

The optional signed job fails early when any setting is missing. The API key is decoded to a mode-restricted runner temporary directory and removed by an EXIT trap. Secrets are scoped only to preflight and signing steps; do not enable shell tracing/debug environment dumps. The job's ephemeral built-in `github.token` is supplied only to publishing, not builder or app packaging. Never package a personal PAT.

Signed gates: tests → forceCodeSigning + app notarization/stapling → ZIP extraction → arm64/version/Developer Team/hardened runtime/codesign deep strict verification → Gatekeeper assessment/staple validation → explicit DMG notarization Accepted + staple/Gatekeeper checks → mounted DMG app verification → regenerated `latest-mac.yml` SHA-512 metadata + SHA-256 manifest → draft upload → byte-for-byte readback → explicit optional promotion. JSON-form `latest-mac.yml` is valid YAML. Blockmaps are intentionally not published; full ZIP updates remain possible. The signing path depends on builder's matching private GitHub publish configuration and signed-client Team identity checks; it must not enable signed auto-update for personal/ad-hoc builds.

```sh
gh workflow run macos-release.yml --ref main \
  -f commit=REVIEWED_MAIN_40_HEX_SHA -f tag=v0.5.0 -f promote=true
```

Optional `distribution/homebrew/install-private.py` is a separate **signed-only** verification/install helper for `/Applications`, not the default personal manager. It requires a trusted expected Team ID and refuses existing bundles. Homebrew does not magically authenticate private GitHub cask URLs; no public cask/tap is registered.

## Local executable verification

```sh
node --import tsx --test tests/distribution*.test.ts
python3 distribution/prce --help
python3 -m py_compile distribution/prce distribution/*.py distribution/homebrew/*.py
bash -n distribution/verify-macos.sh distribution/validate-release.sh distribution/publish-release.sh distribution/publish-personal.sh
actionlint .github/workflows/*.yml
```

Unit tests use explicit temporary fixtures/subprocess doubles for macOS-only APIs; they do not claim Linux executed launchctl, codesign, notarization, GitHub release writes, or a Mac GUI. Official action SHA pins were resolved from each repository's releases API and tag commit API: checkout v7.0.1, setup-node v7.0.0, upload-artifact v7.0.1. Lint tooling should likewise be obtained from its official release with checksum validation.
