#!/bin/bash
set -euo pipefail
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || exit 1
: "${APPLE_TEAM_ID:?}" "${APPLE_API_KEY:?}" "${APPLE_API_KEY_ID:?}" "${APPLE_API_ISSUER:?}" "${RELEASE_TAG:?}"
version=$(python3 distribution/release.py version "$RELEASE_TAG" package.json)
# Builder notarizes/staples the app before ZIP/DMG creation. Check ZIP independently.
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
zip=$(python3 -c 'from pathlib import Path; p=list(Path("release").glob("*.zip")); assert len(p)==1; print(p[0])')
dmg=$(python3 -c 'from pathlib import Path; p=list(Path("release").glob("*.dmg")); assert len(p)==1; print(p[0])')
/usr/bin/ditto -x -k "$zip" "$work/zip"
app=$(python3 -c 'import sys; from pathlib import Path; p=list(Path(sys.argv[1]).glob("*.app")); assert len(p)==1; print(p[0])' "$work/zip")
bash distribution/verify-macos.sh "$app" "$APPLE_TEAM_ID" "$version"
# DMG notarization is explicit; changing/stapling bytes precedes hash generation.
xcrun notarytool submit "$dmg" --key "$APPLE_API_KEY" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER" --wait --output-format json > "$work/notary.json"
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["status"] == "Accepted", "DMG notarization rejected"' "$work/notary.json"
xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
/usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$dmg"
mkdir "$work/mount"
hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$work/mount"
trap 'hdiutil detach "$work/mount" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
app=$(python3 -c 'import sys; from pathlib import Path; p=list(Path(sys.argv[1]).glob("*.app")); assert len(p)==1; print(p[0])' "$work/mount")
bash distribution/verify-macos.sh "$app" "$APPLE_TEAM_ID" "$version"
hdiutil detach "$work/mount"
trap 'rm -rf "$work"' EXIT
python3 distribution/release.py manifest "$RELEASE_TAG" release
python3 distribution/release.py verify "$RELEASE_TAG" release
