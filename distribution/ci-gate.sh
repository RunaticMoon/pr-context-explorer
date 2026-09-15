#!/bin/bash
# Independent diagnostic steps do not authorize releasing partial builds.
set -eu
if [ "$#" -ne 3 ]; then
  printf '%s\n' 'Expected regression, desktop and package outcomes.' >&2
  exit 1
fi
for outcome in "$@"; do
  if [ "$outcome" != success ]; then
    printf '%s\n' 'A required Mac validation gate did not succeed; no artifacts authorized.' >&2
    exit 1
  fi
done
printf '%s\n' 'All required Mac validation gates succeeded.'
