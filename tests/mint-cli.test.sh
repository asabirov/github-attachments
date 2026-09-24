#!/usr/bin/env bash
# What mint.sh refuses, and how fast.
#
# Every case here is a refusal that happens before a browser starts. That is the point:
# a bad --repo or a 12 MB file should cost nothing, and the failure that actually hurt in
# testing was an over-size image that uploaded for a minute and then timed out, because
# GitHub rejects on size after the transfer rather than before it.

set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mint="$here/scripts/mint.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

pass=0; fail=0
check() { # check <name> <expected-exit> <expected-substring> -- cmd...
	local name="$1" want="$2" needle="$3"; shift 4
	local out; out="$("$@" 2>&1)"; local got=$?
	# No pipe. `printf | grep -q` reads a pipeline's status under `set -o pipefail`,
	# and grep exits the moment it matches -- so printf can take EPIPE on a long
	# enough output and fail a check whose exit code and text were both right. The
	# outputs here are short, and 140 runs (60 idle, 80 under load) did not produce
	# it, so this is the shape being removed rather than a failure being fixed. It
	# also drops the `--` guard: half these expectations start with a dash and grep
	# would have read them as its own flags, which `==` never does.
	if [ "$got" = "$want" ] && [[ "$out" == *"$needle"* ]]; then
		pass=$((pass + 1)); printf 'ok   %s\n' "$name"
	else
		fail=$((fail + 1)); printf 'FAIL %s (exit %s, wanted %s)\n     %s\n' "$name" "$got" "$want" "$out"
	fi
}

printf 'x' > "$tmp/tiny.png"

check "no arguments prints usage"        2 "mint.sh <image>"     -- "$mint"
check "missing --repo is named"          2 "--repo <owner/name>" -- "$mint" "$tmp/tiny.png"
check "missing file is named"            2 "no such file"        -- "$mint" "$tmp/absent.png" --repo a/b
check "bare repo name is refused"        2 "wants owner/name"    -- "$mint" "$tmp/tiny.png" --repo notaslug
check "unknown flag is refused"          2 "unknown flag"        -- "$mint" "$tmp/tiny.png" --repo a/b --nope
check "unknown driver is refused"        2 "auto, orca or chrome" -- "$mint" "$tmp/tiny.png" --repo a/b --driver ie6

# 11 MB, over GitHub's 10 MB ceiling, and refused without a browser ever starting.
mkfile_size=$((11 * 1024 * 1024))
dd if=/dev/zero of="$tmp/huge.png" bs=1024 count=$((mkfile_size / 1024)) 2>/dev/null
check "oversize image is refused early"  2 "limit is 10 MB"      -- "$mint" "$tmp/huge.png" --repo a/b

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
