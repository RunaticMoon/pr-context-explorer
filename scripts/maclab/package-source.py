#!/usr/bin/env python3
"""Create an allowlisted, SHA-256 inventoried Maclab source bundle; never starts a Mac."""
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BASELINE = sys.argv[1] if len(sys.argv) > 1 else 'e1d239d60674c1240087078534a44c45aa72a3bc'
OUTPUT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else ROOT / '.cache/maclab/ui-review.tar'

def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])

def allowed(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts:
        return False
    if any(x.startswith('.env') or x in {'.git', '.ssh', '.config', 'node_modules', 'credentials'}
           or x.lower().endswith(('.pem', '.key', '.p12', '.mobileprovision')) for x in p.parts):
        return False
    if name.startswith(('desktop/build/', 'desktop/vendor/')):
        return False
    # These two tracked, public fixtures are imported by tests/typechecking.
    # Do not allow the artifacts directory wholesale: it can hold local evidence.
    return p.parts[0] in {'src', 'desktop', 'scripts', 'tests', 'public', 'distribution'} or name.startswith('references/pr-context-reviewer-prompts/runtime/') or name in {'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'playwright.config.ts', 'index.html', 'artifacts/jira-integration-example.ts', 'artifacts/ai-cli-verification.json'}

baseline_sha = git('rev-parse', '--verify', BASELINE + '^{commit}').decode().strip()
head_sha = git('rev-parse', 'HEAD').decode().strip()
files = {}
# Archive the historical tree, never copy a developer's .git directory.
with tarfile.open(fileobj=io.BytesIO(git('archive', baseline_sha)), mode='r:') as archive:
    for member in archive.getmembers():
        if allowed(member.name) and member.isfile():
            files['before/' + member.name] = (archive.extractfile(member).read(), member.mode & 0o777)
        elif allowed(member.name) and member.issym():
            raise SystemExit('Source symlink requires explicit review: ' + member.name)
for name in sorted(set(git('ls-files', '-z').decode().split('\0') + git('ls-files', '--others', '--exclude-standard', '-z').decode().split('\0'))):
    if not name or not allowed(name):
        continue
    source = ROOT / name
    if source.is_symlink():
        raise SystemExit('Source symlink requires explicit review: ' + name)
    if source.is_file():
        files['after/' + name] = (source.read_bytes(), source.stat().st_mode & 0o777)
for name in ['scripts/maclab/build-remote.sh', 'scripts/maclab/review.mjs', 'scripts/maclab/verify-source.py', 'scripts/maclab/run-review.sh']:
    if 'after/' + name not in files:
        raise SystemExit('Required driver missing: ' + name)
    files[name] = files['after/' + name]
if 'after/scripts/ux-fixture.ts' not in files:
    raise SystemExit('Missing explicit synthetic PR fixture: scripts/ux-fixture.ts')
plist = '''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>PRCE Maclab Review</string>
<key>CFBundleIdentifier</key><string>dev.prce.maclab.review</string>
<key>CFBundleExecutable</key><string>Review</string><key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>
'''
files['PRCEReview.app/Contents/Info.plist'] = (plist.encode(), 0o644)
files['PRCEReview.app/Contents/MacOS/Review'] = (b'#!/bin/sh\necho "Review preparation envelope only. Build and launch the real installed PR Context Explorer.app with scripts/maclab/review.mjs."\n', 0o755)
manifest = {
    'version': 1, 'purpose': 'Explicit synthetic PR fixtures; no credentials or user data',
    'before_commit': baseline_sha, 'after_head': head_sha,
    'after_has_worktree_changes': bool(git('status', '--porcelain', '--untracked-files=normal').strip()),
    'files': {name: {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'mode': oct(mode)} for name, (data, mode) in sorted(files.items())},
}
files['source-manifest.json'] = ((json.dumps(manifest, indent=2, sort_keys=True) + '\n').encode(), 0o644)
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
with tempfile.NamedTemporaryFile(dir=OUTPUT.parent, prefix='.ui-review-', delete=False) as temporary:
    temporary_name = temporary.name
try:
    with tarfile.open(temporary_name, 'w') as archive:
        for name, (data, mode) in sorted(files.items()):
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), mode, 0
            archive.addfile(info, io.BytesIO(data))
    os.replace(temporary_name, OUTPUT)
finally:
    if os.path.exists(temporary_name):
        os.unlink(temporary_name)
sha = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_suffix(OUTPUT.suffix + '.sha256').write_text(sha + '  ' + OUTPUT.name + '\n')
print(json.dumps({'artifact': str(OUTPUT), 'sha256': sha, 'bytes': OUTPUT.stat().st_size, 'before_commit': baseline_sha, 'after_head': head_sha, 'after_has_worktree_changes': manifest['after_has_worktree_changes']}, indent=2))
