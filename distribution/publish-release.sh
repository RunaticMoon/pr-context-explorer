#!/bin/bash
# Only called after tests, signature and notarization gates, with job-scoped GH_TOKEN.
set -euo pipefail
: "${GH_TOKEN:?}" "${GITHUB_REPOSITORY:?}" "${GITHUB_SHA:?}" "${RELEASE_TAG:?}"
[[ ${PROMOTE:-false} == true || ${PROMOTE:-false} == false ]] || exit 1
python3 distribution/release.py version "$RELEASE_TAG" package.json
python3 distribution/release.py verify "$RELEASE_TAG" release
[[ $(gh api "repos/$GITHUB_REPOSITORY" --jq .private) == true ]] || { printf '%s\n' 'Private repository required' >&2; exit 1; }
# Never update/reuse an existing release or tag (even drafts). No --clobber.
refs=$(gh api "repos/$GITHUB_REPOSITORY/git/matching-refs/tags/$RELEASE_TAG")
REFS="$refs" python3 -c 'import json,os; assert not any(r["ref"] == "refs/tags/"+os.environ["RELEASE_TAG"] for r in json.loads(os.environ["REFS"])), "Tag already exists; operator recovery required"'
gh api --paginate --slurp "repos/$GITHUB_REPOSITORY/releases?per_page=100" | python3 -c 'import json,os,sys; assert not any(r["tag_name"] == os.environ["RELEASE_TAG"] for page in json.load(sys.stdin) for r in page), "Release/draft already exists: operator recovery required"'
gh release create "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --draft --title "$RELEASE_TAG" --notes "Signed and notarized Apple Silicon release from $GITHUB_SHA."
assets=(release/*.zip release/*.dmg release/latest-mac.yml release/release-manifest.json)
gh release upload "$RELEASE_TAG" "${assets[@]}" --repo "$GITHUB_REPOSITORY"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gh release download "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --dir "$work"
# Read back uploaded bytes; remote manifest alone is not a verification source.
for asset in "${assets[@]}"; do cmp "$asset" "$work/$(basename "$asset")"; done
python3 distribution/release.py verify "$RELEASE_TAG" "$work"
info=$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft,assets)
INFO="$info" python3 -c 'import json,os; r=json.loads(os.environ["INFO"]); assert r["isDraft"] and len(r["assets"])==4'
if [[ ${PROMOTE:-false} == true ]]; then
  gh release edit "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --draft=false --prerelease=false --latest
  [[ $(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft) == false ]]
fi
