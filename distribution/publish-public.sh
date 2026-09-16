#!/bin/bash
# Never trace or expand the publisher credential in a command argument.
set +x
set -euo pipefail
[[ $# == 0 ]] || { printf '%s\n' 'No arguments accepted.' >&2; exit 1; }
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/public-manifest.py" publish "${PUBLIC_RELEASE_DIRECTORY:-release}"
