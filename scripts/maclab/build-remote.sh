#!/bin/bash
# Build and install only inside this disposable Maclab archive. Never publishes.
set -euo pipefail
umask 077
REVIEW_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
REVIEW_PHASE="${1:?Usage: build-remote.sh before|after}"
case "$REVIEW_PHASE" in before|after) ;; *) echo 'Expected before or after' >&2; exit 2;; esac
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || { echo 'macOS arm64 host required' >&2; exit 1; }
# Bootstrap the same independently pinned Node sidecar used by this repository.
# This stays inside the run directory and does not install a host package.
REVIEW_NODE_ARCHIVE="$REVIEW_ROOT/tooling/node-v24.21.0-darwin-arm64.tar.gz"
mkdir -p "$REVIEW_ROOT/tooling"
if [[ ! -f "$REVIEW_NODE_ARCHIVE" ]]; then
  /usr/bin/curl --proto '=https' --tlsv1.2 --fail --silent --show-error --max-time 120 https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz -o "$REVIEW_NODE_ARCHIVE"
fi
[[ "$(/usr/bin/shasum -a 256 "$REVIEW_NODE_ARCHIVE" | cut -d ' ' -f 1)" == bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ]] || { echo 'Pinned Node checksum mismatch' >&2; exit 1; }
if [[ ! -x "$REVIEW_ROOT/tooling/node/bin/node" ]]; then
  mkdir -p "$REVIEW_ROOT/tooling/node"
  /usr/bin/tar -xzf "$REVIEW_NODE_ARCHIVE" -C "$REVIEW_ROOT/tooling/node" --strip-components 1
fi
export PATH="$REVIEW_ROOT/tooling/node/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
node -e 'if (process.versions.node !== "24.21.0") throw Error("Pinned Node host required")'
/usr/bin/xcrun --find clang >/dev/null
/usr/bin/python3 "$REVIEW_ROOT/scripts/maclab/verify-source.py" "$REVIEW_PHASE"
REVIEW_SOURCE="$REVIEW_ROOT/$REVIEW_PHASE"
REVIEW_INSTALL="$REVIEW_ROOT/Applications/$REVIEW_PHASE/PR Context Explorer.app"
[[ ! -e "$REVIEW_INSTALL" ]] || { echo 'Existing installed review bundle preserved; use a new run' >&2; exit 1; }
cd "$REVIEW_SOURCE"
# npm never receives the operator's credentials/config. Electron still downloads
# its pinned runtime during npm ci. Package lock pins all other dependencies.
mkdir -p "$REVIEW_ROOT/build-home" "$REVIEW_ROOT/npm-cache"
REVIEW_NODE_DIR="$(dirname "$(command -v node)")"
env -i PATH="$REVIEW_NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$REVIEW_ROOT/build-home" npm_config_userconfig=/dev/null npm_config_cache="$REVIEW_ROOT/npm-cache" npm ci --no-audit --no-fund
# Public update checks are disabled in this review build; updater code, auth, and
# sandbox remain intact. Build is ad-hoc signed; no Apple account is used.
env -i PATH="$REVIEW_NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$REVIEW_ROOT/build-home" PRCE_PUBLIC_UPDATES=0 CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack:mac
[[ -d 'release/mac-arm64/PR Context Explorer.app' ]] || { echo 'Packaged app not produced at expected path' >&2; exit 1; }
mkdir -p "$(dirname "$REVIEW_INSTALL")"
/usr/bin/ditto 'release/mac-arm64/PR Context Explorer.app' "$REVIEW_INSTALL"
/usr/bin/codesign --verify --deep --strict "$REVIEW_INSTALL"
# Keep immutable-source and installed-app hashes separate. The app lives outside
# each checkout and outside all ancestor node_modules directories.
node --input-type=module - "$REVIEW_ROOT" "$REVIEW_PHASE" "$REVIEW_INSTALL" <<'JS'
import { readFileSync, writeFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const [root, phase, app] = process.argv.slice(2);
const hashes = {};
function walk(dir) { for (const name of readdirSync(dir).sort()) {
  const file = path.join(dir, name), st = lstatSync(file);
  if (st.isDirectory()) walk(file);
  else if (st.isFile()) hashes[path.relative(app, file)] = createHash('sha256').update(readFileSync(file)).digest('hex');
}}
walk(app);
const source = JSON.parse(readFileSync(path.join(root, 'source-manifest.json')));
writeFileSync(path.join(root, 'Applications', phase, 'installed-manifest.json'), JSON.stringify({ phase, baseline: source.before_commit, head: source.after_head, sourceInventorySha256: createHash('sha256').update(readFileSync(path.join(root, 'source-manifest.json'))).digest('hex'), reviewBuild: { publicUpdates: false, signed: 'ad-hoc' }, files: hashes }, null, 2));
console.log(JSON.stringify({ installed: phase, fileCount: Object.keys(hashes).length, publicUpdates: false }));
JS
