# Optional Homebrew convenience

Homebrew is used to install prerequisites, **not** to bypass authentication on a private GitHub cask URL:

```sh
brew install gh python
gh auth login --hostname github.com
python3 distribution/prce install --tag v0.4.0
```

The default personal manager is `../prce`: installs to `~/Applications`, checks/updates via authenticated `gh`, and optionally schedules an explicit per-user launchAgent. There is no public tap, static-token cask, or npm public package. See [`docs/MACOS-RELEASE.md`](../../docs/MACOS-RELEASE.md) for private-Git npm installation and trust limitations.

`install-private.py` is the **optional future signed-only** helper. It downloads the signed release assets via `gh`, verifies hashes, safe archive paths, expected Developer Team, codesign, Gatekeeper, and notarization staple; only then can `--install` copy a new app to `/Applications`. It refuses an existing bundle and never obtains administrator rights automatically:

```sh
python3 distribution/homebrew/install-private.py \
  --repo RunaticMoon/pr-context-explorer --tag v0.5.0 \
  --team-id YOUR_10_CHARACTER_TEAM_ID --install
```

The tag and Team ID are placeholders, not provisioned identities. This signed-only helper is not usable with the default personal unsigned releases.
