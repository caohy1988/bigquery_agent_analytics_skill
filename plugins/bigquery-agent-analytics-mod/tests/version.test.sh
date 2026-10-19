#!/usr/bin/env bash
# The mod's version is in two places: the manifest, which the host reads, and
# PLUGIN_VERSION, which the welcome card greets and every row's writer label
# carries. They must agree: a manifest bumped alone would greet no update.
# Run from anywhere:
#   bash tests/version.test.sh
set -euo pipefail

plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$plugin/.claude-plugin/plugin.json" | head -n 1)"
code="$(sed -n "s/^export const PLUGIN_VERSION = '\([^']*\)'.*/\1/p" "$plugin/hooks/lib/config.ts" | head -n 1)"
if [ -n "$manifest" ] && [ "$manifest" = "$code" ]; then
  echo "ok - plugin.json and PLUGIN_VERSION agree ($manifest)"
else
  echo "not ok - plugin.json says '$manifest', PLUGIN_VERSION says '$code'"
  exit 1
fi
