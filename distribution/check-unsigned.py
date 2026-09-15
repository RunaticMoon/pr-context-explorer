#!/usr/bin/env python3
"""Unsigned artifact checks are not notarization or positive updater proof."""
import platform
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path

if platform.system() != 'Darwin' or platform.machine() != 'arm64':
    sys.exit('Apple Silicon macOS required')
root = Path(sys.argv[1])
for ext in ('zip', 'dmg'):
    candidates = list(root.glob('*.' + ext))
    assert len(candidates) == 1 and candidates[0].stat().st_size > 0
with tempfile.TemporaryDirectory() as temporary:
    subprocess.run(['ditto', '-x', '-k', str(next(root.glob('*.zip'))), temporary], check=True)
    apps = list(Path(temporary).glob('*.app'))
    assert len(apps) == 1
    app = apps[0]
    plist = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    executable = plist['CFBundleExecutable']
    assert '/' not in executable
    assert subprocess.check_output(['lipo', '-archs', str(app / 'Contents/MacOS' / executable)], text=True).strip() == 'arm64'
    signature = subprocess.run(['codesign', '-dvv', str(app)], capture_output=True, text=True)
    assert 'Authority=Developer ID Application:' not in signature.stderr, 'Unsigned workflow unexpectedly has production identity'
print('Unsigned ZIP/DMG present; delivered executable is arm64. Production updater intentionally unavailable.')
