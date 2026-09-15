#!/usr/bin/env python3
"""Authenticated private-release installer. Homebrew supplies gh, not private URL auth."""
import argparse
import json
from pathlib import Path
import platform
import re
import runpy
import subprocess
import sys
import tempfile


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release import require, version, verify  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True, help='Existing private OWNER/REPO')
    parser.add_argument('--tag', required=True, help='Exact stable release tag')
    parser.add_argument('--team-id', required=True, help='Expected Developer ID Team from a trusted channel')
    parser.add_argument('--install', action='store_true', help='Install into /Applications; refuses existing app')
    args = parser.parse_args()
    v = version(args.tag)
    require(re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repo), 'Invalid repository')
    require(re.fullmatch(r'[A-Z0-9]{10}', args.team_id), 'Invalid Team ID')
    require(platform.system() == 'Darwin' and platform.machine() == 'arm64', 'Apple Silicon macOS required')
    subprocess.run(['gh', 'auth', 'status', '--hostname', 'github.com'], check=True)
    private = subprocess.check_output(['gh', 'api', 'repos/' + args.repo, '--jq', '.private'], text=True).strip()
    require(private == 'true', 'Expected private repository')
    info = json.loads(subprocess.check_output(['gh', 'release', 'view', args.tag, '--repo', args.repo, '--json', 'isDraft,isPrerelease,tagName'], text=True))
    require(not info['isDraft'] and not info['isPrerelease'] and info['tagName'] == args.tag, 'Published stable release required')
    with tempfile.TemporaryDirectory(prefix='pr-context-install-') as temporary:
        root = Path(temporary)
        command = ['gh', 'release', 'download', args.tag, '--repo', args.repo, '--dir', temporary]
        for name in (f'PR-Context-Explorer-{v}-arm64.zip', f'PR-Context-Explorer-{v}-arm64.dmg', 'latest-mac.yml', 'release-manifest.json'):
            command += ['--pattern', name]
        subprocess.run(command, check=True)
        verify(args.tag, root)
        archive = next(root.glob('*.zip'))
        extracted = root / 'extracted'
        manager = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'prce'))
        app = manager['extract_app'](archive, extracted)
        verifier = Path(__file__).resolve().parents[1] / 'verify-macos.sh'
        subprocess.run(['bash', str(verifier), str(app), args.team_id, v], check=True)
        if args.install:
            destination = Path('/Applications') / app.name
            require(not destination.exists() and not destination.is_symlink(), 'App already exists; use signed in-app updater, or explicitly remove old bundle first (not user data)')
            subprocess.run(['ditto', str(app), str(destination)], check=True)
            subprocess.run(['bash', str(verifier), str(destination), args.team_id, v], check=True)
            print('Installed and verified: ' + str(destination))
        else:
            print('Verified only. Re-run with --install to install into /Applications.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
