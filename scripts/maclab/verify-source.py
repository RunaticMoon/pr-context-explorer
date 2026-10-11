#!/usr/bin/env python3
"""Verify exact bundled inputs before any build; generated files are outside this inventory."""
import hashlib
import json
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[2]
manifest = json.loads((root / 'source-manifest.json').read_text())
phase = sys.argv[1] if len(sys.argv) > 1 else 'all'
if phase not in {'all', 'before', 'after'}:
    raise SystemExit('Expected before, after or all')
count = 0
for name, expected in manifest['files'].items():
    if phase != 'all' and not name.startswith(phase + '/'):
        continue
    file = root / name
    if file.is_symlink() or not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest() != expected['sha256']:
        raise SystemExit('Source integrity failure: ' + name)
    count += 1
print(json.dumps({'source_verified': phase, 'file_count': count, 'before_commit': manifest['before_commit'], 'after_head': manifest['after_head'], 'after_has_worktree_changes': manifest['after_has_worktree_changes']}))
