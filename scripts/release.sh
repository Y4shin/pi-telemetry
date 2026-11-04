#!/usr/bin/env bash
# POSIX entry point for the local release flow, kept for the documented
# `./scripts/release.sh` workflow. The release logic lives in release.mjs,
# which runs on Linux, macOS and Windows (Node >= 24); this wrapper only
# forwards its arguments.
#
# Usage: ./scripts/release.sh [--yes]
# Cross-platform equivalent: npm run release -- [--yes]

set -euo pipefail

exec node "$(dirname "$0")/release.mjs" "$@"
