#!/bin/bash
# Checks the host's `$.state` as tests/reload.test.mjs models it, with the
# host CLI's own test runtime: copies the small mod in tests/state-contract
# to a scratch folder, its check as tests/state.test.ts, and runs its tests.
set -u
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$here/state-contract/." "$work/"
mkdir -p "$work/tests"
mv "$work/state.contract.ts" "$work/tests/state.test.ts"
out=$(cd "$work" && claude plugin test . 2>&1)
echo "$out" | grep -E '^\((pass|fail)\)'
echo "$out" | grep -qE '^ *0 fail' && echo "ok - the host's \$.state reads one moment a dispatch, refreshed whole by a write of its own" && exit 0
echo "not ok - the host's \$.state no longer matches what the reload test models"
exit 1
