#!/usr/bin/env bash
# Keep the public driver entry point; JSON and the bounded browser call live in Node.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/orca.mjs" "$@"
