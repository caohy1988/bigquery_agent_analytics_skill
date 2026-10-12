#!/bin/bash
# Shared body of every hook script. The agent waits for the hook before it
# goes on (PreToolUse and PostToolUse wrap every tool call), so this must
# never block or fail. Besides bash itself it only runs base utilities
# (dirname, cat), starts the Python adapter detached from the hook's stdio,
# waits at most BQAA_HOOK_WAIT_SECONDS (default 1) for it, and always exits
# 0. Python is the part that can stall: on macOS a hung syspolicyd blocks
# every launch of a non-Apple interpreter until launchd replaces the daemon.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_BIN="${BQAA_PYTHON:-python3}"
HOOK_NAME="${1:-}"

if [[ "${BQAA_TRACE_ENABLED:-true}" != "true" ]]; then
  exit 0
fi

# Without a project and dataset nothing can be written (dry-run aside), so
# don't start Python at all. Mirrors BQAAConfig.from_env() and _emit_row().
case "${BQAA_DRY_RUN:-false}" in
  [Tt][Rr][Uu][Ee]) ;;
  *)
    if [[ -z "${BQAA_PROJECT_ID:-${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}}" ||
          -z "${BQAA_DATASET:-${BQ_DATASET:-}}" ]]; then
      exit 0
    fi
    ;;
esac

# Drain stdin up front so the agent's write completes even if Python never
# starts.
CAT_BIN=/bin/cat
[[ -x "$CAT_BIN" ]] || CAT_BIN="cat"
PAYLOAD="$("$CAT_BIN" 2>/dev/null)" || PAYLOAD=""

# macOS ships bash 3.2, whose read -t only takes whole seconds.
WAIT_SECONDS="${BQAA_HOOK_WAIT_SECONDS:-1}"
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || WAIT_SECONDS=1
WAIT_SECONDS=$((10#$WAIT_SECONDS))

run_adapter() {
  # Ignore HUP/INT so an event that outlives the wait still lands when the
  # session's terminal goes away.
  trap '' HUP INT
  exec </dev/null 2>/dev/null
  "$PYTHON_BIN" "$PLUGIN_DIR/scripts/bqaa_hook.py" "$HOOK_NAME" <<<"$PAYLOAD" >/dev/null
}

# The subshell keeps the pipe on fd 3 open until Python exits, so read
# returns as soon as Python is done (hooks stay in order in the normal case)
# or after WAIT_SECONDS. Nothing left running holds the hook's own stdout or
# stderr, so the agent isn't kept waiting for EOF either.
if exec 3< <(run_adapter); then
  if ((WAIT_SECONDS > 0)); then
    read -r -t "$WAIT_SECONDS" -u 3 _bqaa_done || true
  fi
  exec 3<&-
else
  (run_adapter >/dev/null) &
fi
exit 0
