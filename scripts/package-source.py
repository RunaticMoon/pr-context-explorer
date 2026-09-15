#!/usr/bin/env python3
"""Build a source-only handoff. Runtime data and tool installs are never included."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT_FILES = {
    'package.json', 'package-lock.json', 'README.md', '.gitignore',
    'index.html', 'tsconfig.json', 'playwright.config.ts', 'vite.config.ts',
}
SOURCE_DIRS = ('src', 'scripts', 'tests', 'docs', 'references')
EXTENSIONS = {'.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.css', '.html', '.py', '.json', '.md', '.txt'}


def build(root: Path, output: Path) -> dict:
    if root.is_symlink():
        raise ValueError('Symlink source root is not permitted')
    root = root.resolve(strict=True)
    selected = [root / name for name in ROOT_FILES if (root / name).is_file()]
    # Exact reviewed, credential-free fixtures required by app tests; not arbitrary logs.
    for name in ('artifacts/ai-cli-verification.json', 'artifacts/jira-integration-example.ts'):
        file = root / name
        if file.is_file():
            selected.append(file)
    for name in SOURCE_DIRS:
        folder = root / name
        if folder.is_symlink():
            raise ValueError('Symlink source directory is not permitted')
        if folder.is_dir():
            selected.extend(
                file for file in folder.rglob('*')
                if file.is_file() and file.suffix in EXTENSIONS
                and not any(part.startswith('.') for part in file.relative_to(root).parts)
            )
    selected.sort(key=lambda file: file.relative_to(root).as_posix())
    records = []
    payloads = []
    for file in selected:
        relative_path = file.relative_to(root)
        current = root
        for part in relative_path.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError('Symlink source path is not permitted')
        content = file.read_bytes()
        relative = file.relative_to(root).as_posix()
        records.append({'path': relative, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
        payloads.append((relative, content))
    manifest = {'format': 'prce-source-manifest-v1', 'files': records,
                'note': 'Source allowlist only; not a content-level secret scanner.'}
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, 'x', zipfile.ZIP_DEFLATED) as archive:
        for relative, content in payloads:
            archive.writestr('pr-context-explorer/' + relative, content)
        archive.writestr('pr-context-explorer/SOURCE-MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError('Archive CRC verification failed')
        for item in records:
            data = archive.read('pr-context-explorer/' + item['path'])
            if hashlib.sha256(data).hexdigest() != item['sha256']:
                raise ValueError('Archive content verification failed')
    return {'archive': str(output.resolve()), 'sourceFiles': len(records), 'bytes': output.stat().st_size,
            'manifestVerified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.root, args.output), ensure_ascii=False))
