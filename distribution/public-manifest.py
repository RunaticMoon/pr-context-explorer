#!/usr/bin/env python3
"""Binary-only public channel metadata and CI publisher; no client credentials.

The manifest sourceCommit is private-build provenance, NOT the public tag target.
Mac signature/runtime validation belongs to the required workflow gates.
"""
import filecmp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

SOURCE = 'RunaticMoon/pr-context-explorer'
PUBLIC = SOURCE + '-releases'
APP = 'PR Context Explorer.app/'
RESOURCES = APP + 'Contents/Resources/'


def require(ok, message):
    if not ok:
        raise ValueError(message)


def context():
    tag = os.environ.get('RELEASE_TAG', '')
    commit = os.environ.get('GITHUB_SHA', '')
    require(re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag) and len(tag) < 64, 'Stable release tag required')
    require(re.fullmatch(r'[0-9a-f]{40}', commit), 'Full lowercase source SHA required')
    require(os.environ.get('GITHUB_REPOSITORY') == SOURCE, 'Private source repository required')
    require(json.loads(Path('package.json').read_text())['version'] == tag[1:], 'Root version mismatch')
    return tag, commit


def checksum(path):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size < 2 * 1024**3, 'Invalid regular asset')
    with path.open('rb') as handle:
        return hashlib.file_digest(handle, 'sha256').hexdigest()


def scan(handle, token):
    if not token:
        return
    previous = b''
    while True:
        chunk = handle.read(1024 * 1024)
        if not chunk:
            return
        data = previous + chunk
        require(token not in data, 'Credential detected in asset')
        previous = data[-max(len(token) - 1, 1):]


def audit(archive, version, token=b''):
    """Audit actual ZIP entries, inventory bytes and packaged version snapshot.

    Bundled JS and dependency package manifests are intentional distribution
    content. Reject private repository/config/user data, not all source-like JS.
    """
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        require(len(entries) < 100000 and sum(i.file_size for i in entries) < 4 * 1024**3, 'ZIP exceeds limits')
        names = set()
        forbidden = {'.git', '.github', '.ssh', '.aws', '.config', '.npmrc', '.netrc', '.git-credentials', '.env', 'credentials.json', 'hosts.yml', 'config.local.json', 'id_rsa', 'id_ed25519', 'application support', 'userdata', 'user-data', '.cache'}
        links = set()
        for item in entries:
            parts = PurePosixPath(item.filename).parts
            require(parts and '..' not in parts and not item.filename.startswith('/') and '\\' not in item.filename, 'Unsafe ZIP path')
            key = '/'.join(parts).casefold()
            require(key not in names, 'Duplicate ZIP path')
            names.add(key)
            require(not any(p.casefold() in forbidden or p.casefold().startswith('.env.') for p in parts), 'Private/config content in ZIP')
            require(not any(p.casefold().endswith(('.pem', '.p12', '.key', '.log')) for p in parts), 'Private key/log content in ZIP')
            require(item.filename.startswith(APP) or item.filename.startswith('__MACOSX/' + APP), 'Unexpected ZIP root')
            relative = item.filename.removeprefix(RESOURCES)
            require(not relative.startswith(('docs/', 'distribution/', 'tests/', 'runtime/docs/', 'runtime/.tools/')), 'Private source/support files in ZIP')
            require(not (item.filename.startswith(RESOURCES) and 'node_modules' not in parts and item.filename.lower().endswith(('.ts', '.tsx', '.map'))), 'Raw private source in ZIP')
            kind = stat.S_IFMT(item.external_attr >> 16)
            require(kind in (0, stat.S_IFREG, stat.S_IFDIR, stat.S_IFLNK), 'Special ZIP member')
            if kind == stat.S_IFLNK:
                target = z.read(item).decode('utf8')
                resolved = os.path.normpath(str(PurePosixPath(item.filename).parent / target))
                require(not target.startswith('/') and '\\' not in target and resolved.startswith(APP), 'Unsafe ZIP link')
                links.add(key)
            if not item.is_dir():
                with z.open(item) as handle:
                    scan(handle, token)
        for item in entries:
            require(not any(str(p).casefold() in links for p in PurePosixPath(item.filename).parents), 'ZIP entry through link')
        info = plistlib.loads(z.read(APP + 'Contents/Info.plist'))
        require(info.get('CFBundleShortVersionString') == version and info.get('CFBundleIdentifier') == 'com.runaticmoon.pr-context-explorer', 'Bundle version/identity mismatch')
        for name in ('node/bin/node', 'runtime/native/prce-macos-acl'):
            require(z.getinfo(RESOURCES + name).file_size > 0, 'Bundled executable missing')
        # Read ASAR header and package snapshot without extracting or executing it.
        with z.open(RESOURCES + 'app.asar') as handle:
            first = handle.read(16)
            require(len(first) == 16, 'Invalid ASAR')
            size_pickle, header_size, payload_size, json_size = struct.unpack('<IIII', first)
            require(size_pickle == 4 and 0 < json_size <= payload_size <= header_size <= 16 * 1024**2, 'Invalid ASAR header')
            tree = json.loads(handle.read(json_size))
            files = tree['files']
            require(set(files) <= {'main.cjs', 'preload.cjs', 'package.json', 'THIRD-PARTY-NOTICES.txt'}, 'Unexpected ASAR files')
            entry = files['package.json']
            require(not entry.get('unpacked') and 'link' not in entry and 0 < entry['size'] < 65536, 'Invalid package snapshot')
            handle.seek(8 + header_size + int(entry['offset']))
            require(json.loads(handle.read(entry['size']))['version'] == version, 'Packaged version mismatch')
        prefix = RESOURCES + 'runtime/'
        inventory = json.loads(z.read(prefix + 'runtime-dependencies.json'))
        require(inventory.get('version') == 1 and inventory.get('roots') == ['typescript', 'ajv'] and inventory.get('files'), 'Invalid dependency inventory')
        actual = {i.filename[len(prefix):] for i in entries if i.filename.startswith(prefix + 'node_modules/') and not i.is_dir()}
        require(actual == set(inventory['files']), 'Dependency inventory membership mismatch')
        for name, digest in inventory['files'].items():
            with z.open(prefix + name) as handle:
                require(hashlib.file_digest(handle, 'sha256').hexdigest() == digest, 'Dependency inventory hash mismatch')


def metadata(root, tag, commit, token=b''):
    archive = root / f'PR-Context-Explorer-{tag[1:]}-arm64.zip'
    dmg = root / f'PR-Context-Explorer-{tag[1:]}-arm64.dmg'
    digest = checksum(archive)
    checksum(dmg)
    require(list(root.glob('*.zip')) == [archive] and list(root.glob('*.dmg')) == [dmg], 'Exactly one named ZIP and DMG required')
    audit(archive, tag[1:], token)
    for path in (archive, dmg):
        with path.open('rb') as handle:
            scan(handle, token)
    return {'schemaVersion': 1, 'channel': 'public-personal-unsigned', 'repository': PUBLIC, 'version': tag[1:], 'tag': tag, 'sourceCommit': commit, 'platform': 'darwin', 'arch': 'arm64', 'asset': {'name': archive.name, 'size': archive.stat().st_size, 'sha256': digest}}


def verify_manifest(path, expected):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size < 65536, 'Invalid public manifest file')

    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'Duplicate manifest key')
            result[key] = value
        return result

    actual = json.loads(path.read_text(), object_pairs_hook=unique)
    # Unlike Python equality, canonical JSON distinguishes true/1 and 1.0/1.
    require(json.dumps(actual, sort_keys=True) == json.dumps(expected, sort_keys=True), 'Public manifest mismatch')


def publish(root, tag, commit):
    require(os.environ.get('GITHUB_ACTIONS') == 'true' and os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'CI dispatch required')
    require(os.environ.get('APPROVE_PUBLIC_RELEASE') == 'true', 'Explicit public approval required')
    token = os.environ.get('PUBLIC_RELEASE_TOKEN', '')
    require(len(token) >= 16, 'CI publisher credential required')
    expected = metadata(root, tag, commit, token.encode())
    manifest = root / 'public-mac.json'
    verify_manifest(manifest, expected)
    with manifest.open('rb') as handle:
        scan(handle, token.encode())
    assets = [root / expected['asset']['name'], root / f'PR-Context-Explorer-{tag[1:]}-arm64.dmg', manifest]
    hashes = {p.name: checksum(p) for p in assets}
    sizes = {p.name: p.stat().st_size for p in assets}
    with tempfile.TemporaryDirectory(prefix='public-publisher-') as directory:
        # No credential helper/config, debug tracing, enterprise routing, proxy or
        # ambient token can override this CI-only credential and fixed GitHub host.
        env = {k: v for k, v in os.environ.items() if k in ('PATH', 'SYSTEMROOT')}
        env.update(GH_TOKEN=token, GH_HOST='github.com', GH_CONFIG_DIR=directory, GH_PROMPT_DISABLED='1', GH_NO_UPDATE_NOTIFIER='1', HOME=directory)

        def gh(args, payload=None):
            result = subprocess.run(['gh', *args], input=json.dumps(payload) if payload is not None else None, text=True, capture_output=True, env=env, timeout=300)
            require(result.returncode == 0, 'GitHub operation failed; manual recovery required')
            return result.stdout

        def api(endpoint, payload=None, method=None, pages=False):
            require(endpoint.startswith('repos/' + PUBLIC + '/') or endpoint in ('repos/' + SOURCE, 'repos/' + PUBLIC), 'Unexpected API repository')
            args = ['api', '--hostname', 'github.com', endpoint]
            if method:
                args += ['--method', method]
            if payload is not None:
                args += ['--input', '-']
            if pages:
                args += ['--paginate', '--slurp']
            return json.loads(gh(args, payload))

        def visibility():
            private = api('repos/' + SOURCE)
            public = api('repos/' + PUBLIC)
            require(private['full_name'] == SOURCE and private['private'] is True, 'Source must remain private')
            require(public['full_name'] == PUBLIC and public['private'] is False and public['default_branch'] == 'main', 'Expected public distribution repository required')

        visibility()
        target = api(f'repos/{PUBLIC}/git/ref/heads/main')['object']
        require(target['type'] == 'commit' and re.fullmatch(r'[0-9a-f]{40}', target['sha']), 'Invalid public target')
        target = target['sha']
        tree = api(f'repos/{PUBLIC}/git/trees/{target}?recursive=1')
        require(tree.get('truncated') is False and len(tree['tree']) == 1 and tree['tree'][0]['path'] == 'README.md' and tree['tree'][0]['type'] == 'blob', 'Public tag target must be README-only')
        refs = api(f'repos/{PUBLIC}/git/matching-refs/tags/{tag}')
        require(not any(r['ref'] == 'refs/tags/' + tag for r in refs), 'Tag exists; manual recovery required')
        releases = api(f'repos/{PUBLIC}/releases?per_page=100', pages=True)
        require(not any(r['tag_name'] == tag for page in releases for r in page), 'Release exists; manual recovery required')
        # Atomically reserve a NEW public tag. This closes the check/create race:
        # a concurrent existing ref fails rather than being reused by Releases.
        api(f'repos/{PUBLIC}/git/refs', {'ref': 'refs/tags/' + tag, 'sha': target}, 'POST')

        def tag_target():
            ref = api(f'repos/{PUBLIC}/git/ref/tags/{tag}')['object']
            require(ref.get('type') == 'commit' and ref.get('sha') == target, 'Public tag target mismatch')

        tag_target()
        # Never target the private SHA: it cannot resolve in the public repository.
        body = f'Public personal unsigned Apple Silicon build. Source commit: {commit}. Ad-hoc signed, NOT Apple Developer ID signed or notarized. macOS may require explicit first-launch approval; no Gatekeeper bypass. ZIP, DMG and public-mac.json only. Public tag targets the README-only distribution repository; manifest sourceCommit records private-build provenance.'
        created = api(f'repos/{PUBLIC}/releases', {'tag_name': tag, 'target_commitish': target, 'name': tag + ' — personal unsigned Apple Silicon', 'body': body, 'draft': True, 'prerelease': False, 'make_latest': 'false'}, 'POST')
        release_id = created['id']
        require(type(release_id) is int and release_id > 0, 'Invalid release ID')
        endpoint = f'repos/{PUBLIC}/releases/{release_id}'

        def record(draft, with_assets=True):
            result = api(endpoint)
            # target_commitish is not the tag's authoritative target once a tag
            # exists; GitHub may retain a branch label. Resolve the actual ref.
            tag_target()
            require(result['id'] == release_id and result['tag_name'] == tag and result['draft'] is draft and result['prerelease'] is False and result['body'] == body, 'Release readback mismatch')
            require(result['html_url'] == f'https://github.com/{PUBLIC}/releases/tag/{tag}', 'Unexpected release repository')
            if with_assets:
                remote = result['assets']
                require(len(remote) == 3 and {a['name']: a['size'] for a in remote} == sizes and all(a['state'] == 'uploaded' for a in remote), 'Release asset readback mismatch')
            else:
                require(result['assets'] == [], 'Draft must start empty')
            return result

        record(True, False)
        gh(['release', 'upload', tag, *(str(p) for p in assets), '--repo', 'github.com/' + PUBLIC])
        record(True)
        downloads = Path(directory) / 'download'
        downloads.mkdir()
        # Official gh uses authenticated API assets and strips cross-host auth.
        # No custom curl redirect chain or token in URL/argv.
        gh(['release', 'download', tag, '--repo', 'github.com/' + PUBLIC, '--dir', str(downloads)])
        require({p.name for p in downloads.iterdir()} == set(hashes), 'Downloaded assets mismatch')
        for name, digest in hashes.items():
            require(checksum(downloads / name) == digest and filecmp.cmp(root / name, downloads / name, shallow=False), 'Downloaded bytes differ')
        visibility()
        tag_target()
        record(True)
        api(endpoint, {'draft': False, 'prerelease': False, 'make_latest': 'true'}, 'PATCH')
        record(False)
        tag_target()
        require(api(f'repos/{PUBLIC}/releases/latest')['id'] == release_id, 'Latest release mismatch')
    print('Public release published; exact assets, tag target and latest read back.')


def main():
    require(len(sys.argv) == 3 and sys.argv[1] in ('generate', 'verify', 'publish'), 'Usage: public-manifest.py generate|verify|publish DIRECTORY')
    tag, commit = context()
    root = Path(sys.argv[2])
    if sys.argv[1] == 'publish':
        publish(root, tag, commit)
        return
    meta = metadata(root, tag, commit)
    path = root / 'public-mac.json'
    if sys.argv[1] == 'generate':
        with path.open('x') as handle:
            json.dump(meta, handle, indent=2)
            handle.write('\n')
    else:
        verify_manifest(path, meta)
    print('Public ZIP metadata and binary-only audit verified; no Apple trust asserted.')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never emit subprocess responses/arguments or asset content with secrets.
        sys.exit('Public release validation failed; no automatic recovery or overwrite.')
