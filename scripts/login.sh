#!/usr/bin/env bash
# The one thing here a human has to do, and it is done once.
#
# GitHub's attachment upload authenticates with a session cookie and a CSRF token. A
# personal access token cannot stand in: tried 2026-09-03 against a real repository id,
# POST github.com/upload/policies/assets answered 422 with GitHub's generic error page
# rather than a policy. So a browser somewhere has to be signed in, and no script can
# sign it in — that is a password and a second factor.
#
# This opens a visible Chrome against the profile this skill owns. Sign in, close the
# window, and every later run is headless and unattended until the session expires.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$here/scripts/drivers/chrome.mjs" "" "" 0 --login
