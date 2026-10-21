#!/usr/bin/env bash
# Live: checks the organization rollout in docs/managed-settings.md in a
# Linux container, with a root-owned managed-settings.json and an
# admin-owned marketplace folder holding this checkout's mod:
#   1. With the policy's options and environment pins, the mod loads as the
#      organization's (the prepend tier), and keeps the policy's destination,
#      token command and live writes, with capture on, against an ordinary
#      user's own settings, a repository's settings and the shell's
#      environment, all saying otherwise.
#   2. Without the environment pins, the shell's BQAA_TRACE_ENABLED=false
#      turns capture off: the pins are needed.
# Offline (--network none), so no request leaves the container, and no model
# is called: /bqaa-status answers by itself.
#
# Needs docker, and the host CLI's Linux build for the container's
# architecture (a single binary), named by HOST_CLI_LINUX:
#   HOST_CLI_LINUX=/path/to/linux/claude bash tests/managed-settings.live.sh
# The work folder goes under $HOME, which docker on a Mac (colima, or Docker
# Desktop) can mount. BQAA_CHECK_IMAGE picks the image (python:3.12-slim).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
plugin="$(dirname "$here")"
image="${BQAA_CHECK_IMAGE:-python:3.12-slim}"
if [[ ! -x "${HOST_CLI_LINUX:-}" ]]; then
  echo "not ok - set HOST_CLI_LINUX to the host CLI's Linux build"
  exit 1
fi
work="$(mktemp -d "$HOME/.bqaa-managed-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/in/mod" "$work/out"
cp "$HOST_CLI_LINUX" "$work/in/claude"
(cd "$plugin" && tar -cf - --exclude ./.claude-plugin/types .) | tar -xf - -C "$work/in/mod"

# The policy: the marketplace folder, the mod on, its options, and (when
# pinned) the environment the mod would otherwise read from the session. Its
# token command prints something too short to be a token, so the notice
# names it: proof that it ran, and no token from the shell or a repository.
policy() { # with or without the environment pins
  cat <<'JSON'
{
  "extraKnownMarketplaces": {
    "org-tools": { "source": { "source": "directory", "path": "/opt/org/agent-plugins" } }
  },
  "enabledPlugins": { "bigquery-agent-analytics-mod@org-tools": true },
  "pluginConfigs": {
    "bigquery-agent-analytics-mod@org-tools": {
      "options": {
        "project": "example-project",
        "dataset": "team_dataset",
        "location": "EU",
        "enabled": true,
        "dryRun": false,
        "accessTokenCommand": "/bin/echo short"
      }
    }
JSON
  if [[ "$1" == pinned ]]; then
    cat <<'JSON'
  },
  "env": {
    "BQAA_TRACE_ENABLED": "true",
    "BQAA_DRY_RUN": "false",
    "BQAA_ACCESS_TOKEN": "",
    "BQAA_AUTO_CREATE_TABLE": "false"
  }
}
JSON
  else
    printf '  }\n}\n'
  fi
}
policy pinned >"$work/in/policy-pinned.json"
policy bare >"$work/in/policy-bare.json"

cat >"$work/in/root.sh" <<'SH'
#!/bin/bash
# As root: the host CLI, the marketplace folder, the policy; then the user's
# own settings and a repository's, each saying otherwise.
set -euo pipefail
install -m 755 /in/claude /usr/local/bin/claude
useradd -m dev
mkdir -p /opt/org/agent-plugins/.claude-plugin /opt/org/agent-plugins/plugins /etc/claude-code
cp -R /in/mod /opt/org/agent-plugins/plugins/bigquery-agent-analytics-mod
cat >/opt/org/agent-plugins/.claude-plugin/marketplace.json <<'JSON'
{ "name": "org-tools", "owner": { "name": "Example Org" },
  "plugins": [ { "name": "bigquery-agent-analytics-mod", "source": "./plugins/bigquery-agent-analytics-mod" } ] }
JSON
install -m 644 "/in/$1" /etc/claude-code/managed-settings.json
chown -R root:root /opt/org /etc/claude-code
chmod -R go-w /opt/org /etc/claude-code
su dev -c 'mkdir -p ~/.claude ~/repo/.claude'
su dev -c 'cat >~/.claude/settings.json' <<'JSON'
{ "enabledPlugins": { "bigquery-agent-analytics-mod@org-tools": false },
  "pluginConfigs": { "bigquery-agent-analytics-mod@org-tools": { "options": { "dataset": "user_dataset", "enabled": false, "dryRun": true } } },
  "env": { "BQAA_DATASET": "user_env_dataset" } }
JSON
su dev -c 'cat >~/repo/.claude/settings.json' <<'JSON'
{ "env": { "BQAA_TRACE_ENABLED": "false", "BQAA_ACCESS_TOKEN": "repository-token" } }
JSON
chmod 777 /out
su dev -c 'cd ~/repo && touch /opt/org/agent-plugins/x 2>/dev/null; touch /etc/claude-code/x 2>/dev/null; ls /opt/org/agent-plugins/x /etc/claude-code/x 2>/dev/null | wc -l >/out/user-wrote'
su dev -c 'cd ~/repo && env BQAA_TRACE_ENABLED=false BQAA_DATASET=shell_dataset BQAA_PROJECT_ID=shell-project BQAA_ACCESS_TOKEN=shell-token \
  DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  timeout 120 claude -p --debug-file /out/debug.log /bqaa-status >/out/status.txt 2>&1'
SH

passed=0
failed=0
check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then passed=$((passed + 1)); echo "ok - $what"; else failed=$((failed + 1)); echo "not ok - $what"; fi
}
scenario() { # policy file
  rm -f "$work/out/"*
  docker run --rm --network none -v "$work/in:/in:ro" -v "$work/out:/out" "$image" bash /in/root.sh "$1" >"$work/out/docker.log" 2>&1
}

scenario policy-pinned.json
status="$work/out/status.txt"
check 'pinned: the user cannot write the marketplace folder or the policy' test "$(cat "$work/out/user-wrote" 2>/dev/null)" = 0
check 'pinned: the mod loads as the organization'"'"'s, in the prepend tier' grep -q 'hooks module bigquery-agent-analytics-mod@org-tools loaded (.*tier prepend' "$work/out/debug.log"
check 'pinned: capture is on, at the policy'"'"'s destination' grep -q 'enabled, target example-project.team_dataset.agent_events (EU)' "$status"
check 'pinned: the policy'"'"'s token command runs (it prints no token), no token from the shell or the repository' grep -q 'token command `echo` printed no access token' "$status"
check 'pinned: writes are live, not a dry run' bash -c "! grep -qi 'dry run' '$status'"
check 'pinned: nothing goes to the user'"'"'s, the repository'"'"'s or the shell'"'"'s dataset' bash -c "! grep -qE 'user_dataset|user_env_dataset|shell_dataset|shell-project' '$status'"

scenario policy-bare.json
check 'unpinned: the shell'"'"'s BQAA_TRACE_ENABLED=false turns capture off' grep -q 'disabled, target example-project.team_dataset.agent_events (EU)' "$work/out/status.txt"

echo "$passed passed, $failed failed"
if ((failed > 0)); then
  echo "--- status"; cat "$work/out/status.txt" 2>/dev/null
  echo "--- docker"; tail -20 "$work/out/docker.log" 2>/dev/null
fi
((failed == 0))
