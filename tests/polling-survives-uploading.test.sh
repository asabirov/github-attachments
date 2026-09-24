#!/usr/bin/env bash
# Exercise the actual driver through a fake Orca CLI, including the pending poll.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --test "$here/orca-driver.test.mjs"
