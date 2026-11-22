#!/usr/bin/env sh
# Builds every ClipSync target into release/v<version>/ . Usage: ./build.sh --server-url=https://your-server
cd "$(dirname "$0")" || exit 1
exec node scripts/build-all.mjs "$@"
