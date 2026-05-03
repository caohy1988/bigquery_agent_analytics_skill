#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_BIN="${BQAA_PYTHON:-python3}"

if [[ "${BQAA_TRACE_ENABLED:-true}" != "true" ]]; then
  exit 0
fi

exec "$PYTHON_BIN" "$PLUGIN_DIR/scripts/bqaa_hook.py" "$1"
