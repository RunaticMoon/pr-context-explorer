#!/usr/bin/env python3
"""Produce the separate personal channel after real Mac app validation."""
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sys
import tempfile

manager = runpy.run_path(str(Path(__file__).with_name('prce')))
root = Path(sys.argv[1])
tag = os.environ['RELEASE_TAG']
commit = os.environ['GITHUB_SHA']
manager['stable'](tag)
assert re.fullmatch(r'[0-9a-f]{40}', commit)
assert os.environ['GITHUB_REPOSITORY'] == manager['REPO']
assert json.loads(Path('package.json').read_text())['version'] == tag[1:]
archive = root / f'PR-Context-Explorer-{tag[1:]}-arm64.zip'
assert len(list(root.glob('*.zip'))) == 1
with tempfile.TemporaryDirectory() as directory:
    app = manager['extract_app'](archive, Path(directory) / 'extracted')
    manager['validate_app'](app, tag[1:])
    # Exercise the exact staged swap path on this real ARM64 app, without touching HOME.
    destination = Path(directory) / 'Applications' / manager['APP_NAME']
    manager['atomic_install'](app, destination, lambda: False, lambda p: manager['validate_app'](p, tag[1:]))
with archive.open('rb') as handle:
    checksum = hashlib.file_digest(handle, 'sha256').hexdigest()
manifest = {'schema': 1, 'channel': 'personal-unsigned', 'repository': manager['REPO'], 'tag': tag, 'commit': commit, 'asset': {'name': archive.name, 'size': archive.stat().st_size, 'sha256': checksum}}
manager['validate_manifest'](manifest, tag, commit)
(root / 'personal-mac.json').write_text(json.dumps(manifest, indent=2) + '\n')
print('Personal ARM64 app and external manager extraction/stage/install validated; no Apple trust asserted.')
