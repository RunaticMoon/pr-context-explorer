#!/bin/bash
set -euo pipefail
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${RELEASE_TAG:?}"
[[ "$GITHUB_REPOSITORY" == RunaticMoon/pr-context-explorer ]]
[[ ${PROMOTE:-false} == true || ${PROMOTE:-false} == false ]]
python3 distribution/release.py version "$RELEASE_TAG" package.json
python3 -c 'import json,os,runpy; from pathlib import Path; m=runpy.run_path("distribution/prce"); a=m["validate_manifest"](json.loads(Path("release/personal-mac.json").read_text()),os.environ["RELEASE_TAG"],os.environ["GITHUB_SHA"]); m["verify_hash"](Path("release")/a["name"],a)'
[[ $(gh api "repos/$GITHUB_REPOSITORY" --jq .private) == true ]]
refs=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$RELEASE_TAG")
REFS="$refs" python3 -c 'import json,os; assert not any(r["ref"] == "refs/tags/"+os.environ["RELEASE_TAG"] for r in json.loads(os.environ["REFS"])), "Tag exists: operator recovery required"'
gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" | python3 -c 'import json,os,sys; assert not any(r["tag_name"] == os.environ["RELEASE_TAG"] for page in json.load(sys.stdin) for r in page), "Release/draft already exists: operator recovery required"'
gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --draft --title "$RELEASE_TAG — personal unsigned Apple Silicon" --notes "Personal unsigned/ad-hoc build from $GITHUB_SHA. NOT Apple Developer ID signed or notarized. Use authenticated prce external manager; first launch may require macOS user approval. This is NOT a signed Squirrel update feed."
assets=(release/*.zip release/*.dmg release/personal-mac.json)
gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --dir "$work"
for asset in "${assets[@]}"; do cmp "$asset" "$work/$(basename "$asset")"; done
info=$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,assets)
INFO="$info" python3 -c 'import json,os; r=json.loads(os.environ["INFO"]); assert r["isDraft"] and len(r["assets"])==3'
if [[ ${PROMOTE:-false} == true ]]; then
  # Not latest: signed updater clients must not select this channel as production.
  gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease=false --latest=false
  [[ $(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft) == false ]]
fi
