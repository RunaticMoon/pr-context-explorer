#!/usr/bin/env python3
"""Fail-closed release utilities. No credentials are read by local validation."""
import base64
import hashlib
import json
import re
import sys
from pathlib import Path


def require(condition, message):
    if not condition:
        raise ValueError(message)


def version(tag, package=None):
    require(re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag), 'Expected stable vMAJOR.MINOR.PATCH tag')
    if package:
        require(json.loads(Path(package).read_text())['version'] == tag[1:], 'Tag/package version mismatch')
    return tag[1:]


def assets(tag, directory):
    v = version(tag)
    root = Path(directory)
    result = []
    for extension in ('zip', 'dmg'):
        paths = list(root.glob('*.' + extension))
        require(len(paths) == 1, 'Expected exactly one ' + extension)
        path = paths[0]
        require(not path.is_symlink() and path.is_file(), 'Asset must be regular file')
        require(re.fullmatch(r'[A-Za-z0-9_-]+-' + re.escape(v) + r'-arm64\.' + extension, path.name), 'Unsafe or wrong-version asset name')
        data = path.read_bytes()
        require(len(data) > 0, 'Empty asset')
        result.append({'name': path.name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'sha512': base64.b64encode(hashlib.sha512(data).digest()).decode()})
    return result


def metadata(tag, entries):
    return {'version': version(tag), 'files': [{'url': a['name'], 'sha512': a['sha512'], 'size': a['size']} for a in entries], 'path': entries[0]['name'], 'sha512': entries[0]['sha512']}


def manifest(tag, directory):
    entries = assets(tag, directory)
    root = Path(directory)
    (root / 'latest-mac.yml').write_text(json.dumps(metadata(tag, entries), indent=2) + '\n')
    # JSON is valid YAML; never parse an untrusted URL from builder output.
    (root / 'release-manifest.json').write_text(json.dumps({'version': version(tag), 'assets': entries}, indent=2) + '\n')


def verify(tag, directory):
    root = Path(directory)
    entries = assets(tag, directory)
    require(json.loads((root / 'release-manifest.json').read_text()) == {'version': version(tag), 'assets': entries}, 'Manifest/hash mismatch')
    require(json.loads((root / 'latest-mac.yml').read_text()) == metadata(tag, entries), 'Updater metadata/hash mismatch')
    print('Verified exact release assets and updater SHA-512 metadata')


def main():
    command, *args = sys.argv[1:]
    if command == 'version':
        print(version(*args))
    elif command == 'manifest':
        manifest(*args)
    elif command == 'verify':
        verify(*args)
    else:
        raise ValueError('Unknown command')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(str(error))
