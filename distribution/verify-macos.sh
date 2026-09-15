#!/bin/bash
# Validate the app actually delivered to users, not only the builder staging app.
set -euo pipefail
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || { printf '%s\n' 'Apple Silicon macOS required' >&2; exit 1; }
app=${1:?Usage: verify-macos.sh APP TEAM_ID [VERSION]}
team=${2:?Expected Developer Team ID required}
[[ $team =~ ^[A-Z0-9]{10}$ ]] || { printf '%s\n' 'Invalid Team ID' >&2; exit 1; }
[[ -d "$app" && ! -L "$app" && "$app" == *.app ]] || exit 1
plist="$app/Contents/Info.plist"
executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")
[[ $executable != */* && -n $executable ]] || exit 1
[[ $(/usr/bin/lipo -archs "$app/Contents/MacOS/$executable") == arm64 ]] || { printf '%s\n' 'Expected arm64-only executable' >&2; exit 1; }
if [[ -n ${3:-} ]]; then
  [[ $(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist") == "$3" ]] || exit 1
fi
/usr/bin/codesign --verify --deep --strict --verbose=2 "$app"
identity=$(/usr/bin/codesign -dvv "$app" 2>&1)
[[ $identity == *"TeamIdentifier=$team"* && $identity == *'Authority=Developer ID Application:'* ]] || { printf '%s\n' 'Developer identity mismatch' >&2; exit 1; }
[[ $identity == *'runtime'* ]] || { printf '%s\n' 'Hardened runtime required' >&2; exit 1; }
/usr/sbin/spctl --assess --type execute --verbose=2 "$app"
xcrun stapler validate "$app"
