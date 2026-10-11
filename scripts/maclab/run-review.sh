#!/bin/bash
set -euo pipefail
REVIEW_ROOT="$(cd "$(dirname "$0")/../.." && pwd -P)"
exec "$REVIEW_ROOT/tooling/node/bin/node" "$REVIEW_ROOT/scripts/maclab/review.mjs" "$@"
