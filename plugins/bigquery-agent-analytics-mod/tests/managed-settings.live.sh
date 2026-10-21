#!/usr/bin/env bash
# Live: checks docs/managed-settings.md in a Linux container, as an ordinary
# user (dev) under a root-owned managed-settings.json. No model is called:
# /bqaa-status answers by itself, and where the mod should not load, the
# check reads the host's debug log.
#
# Offline (--network none), the organization's folder marketplace:
#   pins      the policy, a drop-in file beside an existing
#             managed-settings.json (whose keys still apply), holds its
#             options and environment pins against the person's own
#             settings, a --settings file, a repository's settings and the
#             shell (destination, table, capture, live writes, token
#             command, spool folder, agent name, identity);
#   partial   a policy that pins only some options leaves the rest to the
#             person (why the guide pins every one);
#   unpinned  without the environment pins, the shell and a repository
#             turn capture off and a dry run on;
#   migration an installed settings-hook tracer keeps writing until the
#             policy turns it off, which also refuses a new install of it;
#             allowManagedModsOnly does not stop it, allowManagedHooksOnly
#             does; the mod under its old id never loads beside the
#             organization's;
#   opt-out   a person's enabledPlugins, plugin disable and plugin uninstall
#             leave the mod on; safe mode and bare mode load no plugins;
#   identity  a repository's settings can set USER, and so user_id;
#   token env a repository's settings env reaches the token command
#             (gcloud's interpreter, configuration, proxy and CA variables),
#             and an admin-owned wrapper that starts it with a clean
#             environment keeps them out;
#   disable   the policy's enabledPlugins false unloads the mod, and its
#             kill switch keeps it loaded but recording nothing;
#   rollback  straight after a migration, removing the policy brings the
#             earlier tracer and mod back; a disable policy kept until they
#             are uninstalled does not. With the policy gone the mod is
#             gone, rows left behind stay on disk, are listed again when it
#             comes back, and go when the folder is deleted.
# With BQAA_CHECK_NETWORK=1, the GitHub-sourced variant, pinned to a ref
# (needs network, and an image with git, named by BQAA_CHECK_GIT_IMAGE):
#   github    a fresh machine records nothing in its first session and
#             records by its third (the first two held open, with no input),
#             and from the first after one install from the pinned source;
#             the copy is
#             the ref's (PIN_VERSION), autoUpdate stays off, the policy's
#             options hold, and it runs in the user tier: a person's
#             enabledPlugins and plugin uninstall leave it on, and
#             allowManagedModsOnly and allowManagedHooksOnly refuse it.
#             With the policy removed the copy stays installed and loads,
#             until a disable policy holds it while it is uninstalled.
#             Its policy names the guide's token command for this variant
#             (env -i and gcloud's absolute path, no delivered file): a
#             stand-in gcloud at that path runs with the guide's arguments
#             and gets only PATH, in a repository whose settings set
#             gcloud's variables.
#
#   HOST_CLI_LINUX=/path/to/linux/claude bash tests/managed-settings.live.sh
#   BQAA_CHECK_NETWORK=1 BQAA_CHECK_GIT_IMAGE=my-image-with-git \
#     PIN_REPO=owner/repo PIN_REF=a-tag PIN_VERSION=the-mod-version-there \
#     HOST_CLI_LINUX=... bash tests/managed-settings.live.sh
# The host CLI's Linux build is a single binary for the container's
# architecture. The work folder goes under $HOME, which docker on a Mac
# (colima, or Docker Desktop) can mount. BQAA_CHECK_IMAGE picks the offline
# image (python:3.12-slim).
set -u
here="$(cd "$(dirname "$0")" && pwd)"
plugin="$(dirname "$here")"
image="${BQAA_CHECK_IMAGE:-python:3.12-slim}"
if [[ ! -x "${HOST_CLI_LINUX:-}" ]]; then
  echo "not ok - set HOST_CLI_LINUX to the host CLI's Linux build"
  exit 1
fi
network="${BQAA_CHECK_NETWORK:-0}"
if [[ "$network" == 1 && ( -z "${BQAA_CHECK_GIT_IMAGE:-}" || -z "${PIN_REPO:-}" || -z "${PIN_REF:-}" || -z "${PIN_VERSION:-}" ) ]]; then
  echo "not ok - BQAA_CHECK_NETWORK=1 needs BQAA_CHECK_GIT_IMAGE, PIN_REPO, PIN_REF and PIN_VERSION"
  exit 1
fi
work="$(mktemp -d "$HOME/.bqaa-managed-check.XXXXXX")"
# BQAA_CHECK_KEEP=1 keeps the work folder (each scenario's status, debug
# log and row files) for a look after a failure.
trap '[[ "${BQAA_CHECK_KEEP:-0}" == 1 ]] && echo "kept $work" || rm -rf "$work"' EXIT
mkdir -p "$work/in/mod" "$work/out"
cp "$HOST_CLI_LINUX" "$work/in/claude"
(cd "$plugin" && tar -cf - --exclude ./.claude-plugin/types .) | tar -xf - -C "$work/in/mod"
printf '%s\n%s\n%s\n' "${PIN_REPO:-}" "${PIN_REF:-}" "${PIN_VERSION:-}" >"$work/in/pin"
# A session held open with no input (so no model call), then ended: the time
# a first session gives the host to register a marketplace or install a mod.
cat >"$work/in/hold.py" <<'PY'
import subprocess, sys, time
log, seconds = sys.argv[1], float(sys.argv[2])
session = subprocess.Popen(["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json",
                            "--verbose", "--debug-file", log],
                           stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(seconds)
session.stdin.close()
try:
    session.wait(timeout=60)
except subprocess.TimeoutExpired:
    session.kill()
PY

cat >"$work/in/common.sh" <<'SH'
# Shared by both parts, as root in the container.
set -u
MOD=bigquery-agent-analytics-mod
ORG="$MOD@org-tools"
OLD="$MOD@bigquery-agent-analytics-plugin"
TRACER=bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin
install -m 755 /in/claude /usr/local/bin/claude
useradd -m dev
# What the organization already delivers, and the mod's drop-in beside it.
DROPIN=/etc/claude-code/managed-settings.d/50-bqaa-mod.json
mkdir -p /etc/claude-code/managed-settings.d
cat >/etc/claude-code/managed-settings.json <<'JSON'
{ "permissions": { "deny": ["WebFetch(domain:example.invalid)"] }, "env": { "ORG_EXISTING": "kept" } }
JSON
chmod 644 /etc/claude-code/managed-settings.json
chmod 777 /out
as_dev() { su dev -c "$1"; }
# The policy, written to the drop-in: python that edits the dict `p` (the
# guide's complete example for the folder, or for GitHub with "github" as
# the first argument).
policy() {
  python3 - "$@" <<'PY'
import json, sys
kind, edit = (sys.argv[1], sys.argv[2]) if len(sys.argv) > 2 else ("folder", sys.argv[1])
options = {"project": "example-project", "dataset": "team_dataset", "table": "team_events", "location": "EU",
           "enabled": True, "dryRun": False, "accessTokenCommand": "/bin/echo short", "deadLetterDir": "",
           "agentName": "team-agent", "maxPayloadChars": 16384, "flushIntervalMs": 5000,
           "userIdFromCredentials": False, "recordHostname": False}
env = {"BQAA_TRACE_ENABLED": "true", "BQAA_DRY_RUN": "false", "BQAA_ACCESS_TOKEN": "", "BQAA_DEAD_LETTER_DIR": "",
       "BQAA_USER_ID": "", "BQAA_AUTO_CREATE_TABLE": "false", "BQAA_AUTO_BACKFILL": "true"}
off = {"bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": False,
       "bigquery-agent-analytics-tracing@bqaa-tracing": False}
if kind == "github":
    # The guide's token command for this variant: no file to deliver.
    options["accessTokenCommand"] = ("/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/gcloud auth print-access-token"
                                     " --impersonate-service-account=bqaa-row-writer@example-project.iam.gserviceaccount.com")
    repo, ref, _ = open("/in/pin").read().split("\n")[:3]
    key = "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin"
    p = {"extraKnownMarketplaces": {"bigquery-agent-analytics-plugin": {
            "source": {"source": "github", "repo": repo, "ref": ref}, "autoUpdate": False}},
         "enabledPlugins": {key: True, **off}, "pluginConfigs": {key: {"options": options}}, "env": env}
else:
    key = "bigquery-agent-analytics-mod@org-tools"
    p = {"extraKnownMarketplaces": {"org-tools": {"source": {"source": "directory", "path": "/opt/org/agent-plugins"}}},
         "enabledPlugins": {key: True, "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": False, **off},
         "pluginConfigs": {key: {"options": options}}, "env": env}
exec(edit)
json.dump(p, open("/etc/claude-code/managed-settings.d/50-bqaa-mod.json", "w"), indent=1)
PY
  chown root:root "$DROPIN"
  chmod 644 "$DROPIN"
}
# The guide's disable policy, for a rollback: every id off, and capture off
# for any copy that still loads.
disable_policy() {
  cat >"$DROPIN" <<'JSON'
{ "enabledPlugins": {
    "bigquery-agent-analytics-mod@org-tools": false,
    "bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-mod@bqaa-tracing": false,
    "bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin": false,
    "bigquery-agent-analytics-tracing@bqaa-tracing": false },
  "env": { "BQAA_TRACE_ENABLED": "false" } }
JSON
  chown root:root "$DROPIN"
  chmod 644 "$DROPIN"
}
# The person's own settings (for the plugin key given) and a repository's,
# each saying otherwise.
fresh_user() {
  rm -rf /home/dev/.claude /home/dev/.claude.json /home/dev/.bqaa-mod /home/dev/repo
  as_dev 'mkdir -p ~/.claude ~/repo/.claude'
  python3 - "$1" <<'PY'
import json, sys
key = sys.argv[1]
user = {"enabledPlugins": {key: False},
        "pluginConfigs": {key: {"options": {
            "dataset": "user_dataset", "table": "user_table", "enabled": False, "dryRun": True,
            "deadLetterDir": "/home/dev/repo/spool-user", "agentName": "user-agent", "maxPayloadChars": 1024,
            "recordHostname": True, "userIdFromCredentials": True, "accessTokenCommand": "/bin/echo user-command"}}},
        "env": {"BQAA_DATASET": "user_env_dataset", "BQAA_TABLE": "user_env_table"}}
repo = {"env": {"BQAA_TRACE_ENABLED": "false", "BQAA_ACCESS_TOKEN": "repository-token",
                "BQAA_DEAD_LETTER_DIR": "/home/dev/repo/spool-repo", "BQAA_TABLE": "repo_table", "BQ_TABLE": "repo_bq_table",
                "BQAA_USER_ID": "repo-user", "BQAA_AUTO_BACKFILL": "false", "BQAA_AUTO_CREATE_TABLE": "true",
                "BQAA_DRY_RUN": "true", "BQAA_AGENT_NAME": "repo-agent"}}
json.dump(user, open("/home/dev/.claude/settings.json", "w"))
json.dump(repo, open("/home/dev/repo/.claude/settings.json", "w"))
PY
  chown -R dev:dev /home/dev
}
SHELL_ENV='BQAA_TRACE_ENABLED=false BQAA_DATASET=shell_dataset BQAA_PROJECT_ID=shell-project BQAA_ACCESS_TOKEN=shell-token BQAA_TABLE=shell_table BQAA_DEAD_LETTER_DIR=/home/dev/repo/spool-shell BQAA_USER_ID=shell-user BQAA_AGENT_NAME=shell-agent'
# One session as dev, in ~/repo: /bqaa-status, the debug log, the rows the
# session left on disk (agent, user_id, host name) and every row file.
run() { # scenario, seconds, extra claude arguments, extra environment
  local s="$1" seconds="$2" args="${3:-}" envs="${4:-}"
  mkdir -p "/out/$s" && chmod 777 "/out/$s"
  as_dev "cd ~/repo && env BQAA_SCENARIO=$s DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 $envs \
    timeout $seconds claude -p $args --debug-file /out/$s/debug.log /bqaa-status >/out/$s/status.txt 2>&1"
  as_dev "find ~/.bqaa-mod ~/repo -name '*.jsonl' 2>/dev/null" >"/out/$s/files.txt"
  python3 - /home/dev/.bqaa-mod/dead-letter >"/out/$s/rows.txt" 2>&1 <<'PY'
import glob, json, os, sys
files = sorted(glob.glob(sys.argv[1] + "/*/*.jsonl"), key=os.path.getmtime)
for line in (open(files[-1]).read().splitlines() if files else []):
    try:
        row = json.loads(line).get("row") or {}
    except ValueError:
        continue
    attributes = row.get("attributes")
    attributes = json.loads(attributes) if isinstance(attributes, str) else (attributes or {})
    if row:
        print("agent=%s user_id=%s host_name=%s" % (row.get("agent"), row.get("user_id"),
                                                     (attributes.get("session_metadata") or {}).get("host_name")))
PY
}
hold() { # scenario, seconds
  mkdir -p "/out/$1" && chmod 777 "/out/$1"
  as_dev "cd ~/repo && env BQAA_SCENARIO=$1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 python3 /in/hold.py /out/$1/debug.log $2"
}
SH

cat >"$work/in/offline.sh" <<'SH'
#!/bin/bash
# The folder variant, offline.
. /in/common.sh
mkdir -p /opt/org/agent-plugins/.claude-plugin /opt/org/agent-plugins/plugins
cp -R /in/mod /opt/org/agent-plugins/plugins/$MOD
cat >/opt/org/agent-plugins/.claude-plugin/marketplace.json <<'JSON'
{ "name": "org-tools", "owner": { "name": "Example Org" },
  "plugins": [ { "name": "bigquery-agent-analytics-mod", "source": "./plugins/bigquery-agent-analytics-mod" } ] }
JSON
# The guide's clean-environment wrapper for the token command, here running
# a stand-in for gcloud that writes down the environment it was given.
mkdir -p /opt/org/bin
cat >/opt/org/bin/bqaa-token <<'W'
#!/bin/sh
PATH=/usr/bin:/bin
export PATH
unset LD_PRELOAD LD_LIBRARY_PATH
user=$(/usr/bin/id -un)
home=$(eval echo "~$user")
exec /usr/bin/env -i HOME="$home" PATH=/usr/bin:/bin /bin/sh -c 'env > /out/token-env-wrapped.env; echo short'
W
chmod 755 /opt/org/bin/bqaa-token
# Token commands that write down the environment they were given.
for name in token-env-direct token-env-pinned; do
  printf '#!/bin/sh\nenv > /out/%s.env\necho short\n' "$name" >/opt/org/bin/$name
  chmod 755 /opt/org/bin/$name
done
chown -R root:root /opt/org && chmod -R go-w /opt/org
# What a person may already have: the old marketplace, with the
# settings-hook tracer (a stand-in that logs each hook it runs) and the mod
# under its old id, in a folder of their own.
L=/home/dev/legacy-marketplace
mkdir -p $L/.claude-plugin $L/plugins/bigquery-agent-analytics-tracing/.claude-plugin
cp -R /in/mod $L/plugins/$MOD
cat >$L/.claude-plugin/marketplace.json <<'JSON'
{ "name": "bigquery-agent-analytics-plugin", "owner": { "name": "Earlier" },
  "plugins": [ { "name": "bigquery-agent-analytics-tracing", "source": "./plugins/bigquery-agent-analytics-tracing" },
               { "name": "bigquery-agent-analytics-mod", "source": "./plugins/bigquery-agent-analytics-mod" } ] }
JSON
cat >$L/plugins/bigquery-agent-analytics-tracing/.claude-plugin/plugin.json <<'JSON'
{ "name": "bigquery-agent-analytics-tracing", "version": "0.1.0",
  "hooks": {
    "SessionStart": [ { "hooks": [ { "type": "command", "command": "echo \"$BQAA_SCENARIO\" >> /out/tracer-ran" } ] } ],
    "SessionEnd": [ { "hooks": [ { "type": "command", "command": "echo \"$BQAA_SCENARIO\" >> /out/tracer-ran" } ] } ]
  } }
JSON
chown -R dev:dev $L
as_dev 'touch /opt/org/agent-plugins/x /etc/claude-code/x /etc/claude-code/managed-settings.d/x 2>/dev/null; ls /opt/org/agent-plugins/x /etc/claude-code/x /etc/claude-code/managed-settings.d/x 2>/dev/null | wc -l >/out/user-wrote'

# pins: the complete example against everything the person controls.
fresh_user "$ORG"; policy 'pass'
cat >/home/dev/flags.json <<'JSON'
{ "pluginConfigs": { "bigquery-agent-analytics-mod@org-tools": { "options": { "dataset": "flag_dataset", "table": "flag_table", "enabled": false } } },
  "env": { "BQAA_TRACE_ENABLED": "false" } }
JSON
chown dev:dev /home/dev/flags.json
run pins 60 "" "$SHELL_ENV"
run pins-flags 60 "--settings /home/dev/flags.json" "$SHELL_ENV"
# partial: a policy with only the destination.
fresh_user "$ORG"; policy 'p["pluginConfigs"]["bigquery-agent-analytics-mod@org-tools"]["options"] = {"project": "example-project", "dataset": "team_dataset"}; p["env"] = {}'
run partial 60
# unpinned: the options, without the environment pins.
fresh_user "$ORG"; policy 'p["env"] = {}'
run unpinned 60 "" "$SHELL_ENV"
# migration: the old marketplace installed before any policy, then the
# policy without the old ids turned off, then with them.
rm -f "$DROPIN"
fresh_user "$ORG"
as_dev "cd ~ && claude plugin marketplace add $L && claude plugin install $TRACER && claude plugin install $OLD" >/out/legacy-install.txt 2>&1
run before-policy 60
policy 'del p["enabledPlugins"]["bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin"]; del p["enabledPlugins"]["bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin"]'
run old-ids-left-on 60
policy 'pass'
run old-ids-off 60
policy 'del p["enabledPlugins"]["bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin"]; del p["enabledPlugins"]["bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin"]; p["pluginConfigs"]["cc-plugin-sec-default@builtin"] = {"options": {"allowManagedModsOnly": True}}'
run managed-mods-only 60
policy 'del p["enabledPlugins"]["bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin"]; del p["enabledPlugins"]["bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin"]; p["allowManagedHooksOnly"] = True'
run managed-hooks-only 60
# rollback straight after the migration, the earlier installs still there:
# removing the policy brings them back; the disable policy, kept until they
# are uninstalled, does not.
policy 'pass'
run migrated 60
rm -f "$DROPIN"
run rollback-too-soon 60
disable_policy
run rollback-disabled 15
as_dev "cd ~ && claude plugin uninstall $TRACER && claude plugin uninstall $OLD" >/out/legacy-uninstall.txt 2>&1
rm -f "$DROPIN"
run rollback-done 15
# opt-out: what the person can try (their settings already turn it off).
fresh_user "$ORG"; policy 'pass'
as_dev "cd ~ && claude plugin disable $ORG" >/out/disable.txt 2>&1; echo "exit $?" >>/out/disable.txt
as_dev "cd ~ && claude plugin uninstall $ORG" >/out/uninstall.txt 2>&1; echo "exit $?" >>/out/uninstall.txt
as_dev "cd ~ && claude plugin uninstall $ORG --scope managed" >>/out/uninstall.txt 2>&1; echo "exit $?" >>/out/uninstall.txt
as_dev "cd ~ && claude plugin marketplace add $L && claude plugin install $TRACER" >/out/blocked-install.txt 2>&1
run after-opt-out 60
run safe-mode 15 "--safe-mode"
run safe-mode-env 15 "" "CLAUDE_CODE_SAFE_MODE=1"
run bare 15 "--bare"
# identity: a repository's USER and HOME.
fresh_user "$ORG"
echo '{ "env": { "USER": "someone-else", "HOME": "/home/dev/repo/elsewhere" } }' >/home/dev/repo/.claude/settings.json
run repository-user 60
# token env: a repository's settings env at the token command, directly,
# through the wrapper, and with the policy pinning gcloud's variables.
fresh_user "$ORG"
cat >/home/dev/repo/.claude/settings.json <<'JSON'
{ "env": { "CLOUDSDK_PYTHON": "/tmp/evil-python", "CLOUDSDK_CONFIG": "/tmp/evil-config", "HTTPS_PROXY": "http://evil.invalid:3128",
           "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE": "/tmp/evil-ca", "PYTHONPATH": "/tmp/evil", "PATH": "/tmp/evil-bin:/usr/bin:/bin" } }
JSON
chown dev:dev /home/dev/repo/.claude/settings.json
policy 'p["pluginConfigs"]["bigquery-agent-analytics-mod@org-tools"]["options"]["accessTokenCommand"] = "/opt/org/bin/token-env-direct"'
run token-env-direct 60
policy 'p["pluginConfigs"]["bigquery-agent-analytics-mod@org-tools"]["options"]["accessTokenCommand"] = "/opt/org/bin/bqaa-token"'
run token-env-wrapped 60
policy 'p["pluginConfigs"]["bigquery-agent-analytics-mod@org-tools"]["options"]["accessTokenCommand"] = "/opt/org/bin/token-env-pinned"; p["env"].update({k: "" for k in ("CLOUDSDK_PYTHON", "CLOUDSDK_PYTHON_ARGS", "CLOUDSDK_CONFIG", "HTTPS_PROXY", "HTTP_PROXY", "PYTHONPATH")})'
run token-env-pinned 60
# disable: the policy turns the mod off, or keeps it loaded but recording nothing.
fresh_user "$ORG"; policy 'p["enabledPlugins"]["bigquery-agent-analytics-mod@org-tools"] = False'
run policy-off 15
policy 'p["pluginConfigs"]["bigquery-agent-analytics-mod@org-tools"]["options"]["enabled"] = False; p["env"]["BQAA_TRACE_ENABLED"] = "false"'
run kill-switch 60
# rollback: rows left from a session, the policy removed, put back, the
# folder deleted.
policy 'pass'
run before-rollback 60
mv "$DROPIN" /root/50-bqaa-mod.json
run rolled-back 15
mv /root/50-bqaa-mod.json "$DROPIN"
run restored 60
as_dev 'rm -rf ~/.bqaa-mod/dead-letter'
run purged 60
echo done >/out/done
SH

cat >"$work/in/github.sh" <<'SH'
#!/bin/bash
# The GitHub-sourced variant, pinned to a ref; networked.
. /in/common.sh
REPO="$(sed -n 1p /in/pin)"
REF="$(sed -n 2p /in/pin)"
copies() { as_dev 'ls -d ~/.claude/plugins/cache/*/bigquery-agent-analytics-mod/* 2>/dev/null; python3 -c "import json; d=json.load(open(\"/home/dev/.claude/plugins/known_marketplaces.json\")); print(\"autoUpdate\", d[\"bigquery-agent-analytics-plugin\"].get(\"autoUpdate\"))" 2>/dev/null' >"/out/$1/copies.txt"; }
# A stand-in for gcloud at the path the guide's token command names: it
# writes down its arguments and the environment it was given.
cat >/usr/bin/gcloud <<'G'
#!/bin/sh
printf '%s\n' "$*" >/out/gcloud.args
env >/out/gcloud.env
echo short
G
chmod 755 /usr/bin/gcloud
fresh_user "$OLD"; policy github 'pass'
hold github-1 20; copies github-1
hold github-2 30; copies github-2
run github-3 60; copies github-3
# token env: the same session start in a repository whose settings set
# gcloud's variables.
cat >/home/dev/repo/.claude/settings.json <<'JSON'
{ "env": { "CLOUDSDK_PYTHON": "/tmp/evil-python", "CLOUDSDK_CONFIG": "/tmp/evil-config", "HTTPS_PROXY": "http://evil.invalid:3128",
           "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE": "/tmp/evil-ca", "PYTHONPATH": "/tmp/evil", "PATH": "/tmp/evil-bin:/usr/bin:/bin" } }
JSON
chown dev:dev /home/dev/repo/.claude/settings.json
rm -f /out/gcloud.args /out/gcloud.env
run github-token-env 60
cp /out/gcloud.args /out/gcloud.env /out/github-token-env/ 2>/dev/null
fresh_user "$OLD"
as_dev "cd ~ && claude plugin install $MOD --marketplace '$REPO#$REF'" >/out/pinned-install.txt 2>&1
run pinned-install-1 60; copies pinned-install-1
as_dev "cd ~ && claude plugin uninstall $OLD" >/out/github-uninstall.txt 2>&1; echo "exit $?" >>/out/github-uninstall.txt
run github-after-opt-out 60
policy github 'p["pluginConfigs"]["cc-plugin-sec-default@builtin"] = {"options": {"allowManagedModsOnly": True}}'
run github-managed-mods-only 15
policy github 'p["allowManagedHooksOnly"] = True'
run github-managed-hooks-only 15
# rollback: a copy the person installed stays enabled in their settings
# when the policy is removed, and loads with their own options; the disable
# policy, kept until the copy is uninstalled, leaves nothing.
rm -rf /home/dev/.claude /home/dev/.claude.json && as_dev 'mkdir -p ~/.claude'
policy github 'pass'
as_dev "cd ~ && claude plugin install $MOD --marketplace '$REPO#$REF'" >/out/github-rollback-install.txt 2>&1
run github-before-rollback 60
rm -f "$DROPIN"
run github-policy-removed 60
disable_policy
run github-disabled 15
as_dev "cd ~ && claude plugin uninstall $OLD" >/out/github-rollback-uninstall.txt 2>&1
rm -f "$DROPIN"
run github-rollback-done 15
echo done >/out/done
SH

passed=0
failed=0
check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then passed=$((passed + 1)); echo "ok - $what"; else failed=$((failed + 1)); echo "not ok - $what"; fi
}
out="$work/out"
has() { grep -q -- "$2" "$out/$1/$3" 2>/dev/null; }      # scenario, text, file
lacks() { ! grep -qE -- "$2" "$out/$1/$3" 2>/dev/null; } # scenario, pattern, file
loaded() { grep -q "hooks module $2 loaded" "$out/$1/debug.log" 2>/dev/null; }
not_loaded() { test -s "$out/$1/debug.log" && ! loaded "$1" "$2"; }
rows_are() { test -s "$out/$1/rows.txt" && ! grep -qv -- "^$2\$" "$out/$1/rows.txt"; }
kept() { # every row file of the first scenario is still there after the second
  local file
  test -s "$out/$1/files.txt" || return 1
  while read -r file; do grep -qxF -- "$file" "$out/$2/files.txt" || return 1; done <"$out/$1/files.txt"
}
ORG=bigquery-agent-analytics-mod@org-tools
OLD=bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin
TARGET='enabled, target example-project.team_dataset.team_events (EU)'
OTHERS='user_dataset|user_env_dataset|shell_dataset|shell-project|flag_dataset|user_table|user_env_table|repo_table|repo_bq_table|shell_table|flag_table|dry run'
ROWS='agent=team-agent user_id=dev host_name=None'

export DOCKER_API_VERSION="${DOCKER_API_VERSION:-1.44}"
docker run --rm --network none -v "$work/in:/in:ro" -v "$out:/out" "$image" bash /in/offline.sh >"$out/docker.log" 2>&1
check 'the container ran every offline scenario' test -f "$out/done"
check 'the person cannot write the marketplace folder or the policy' test "$(cat "$out/user-wrote" 2>/dev/null)" = 0
for s in pins pins-flags; do
  check "$s: the mod loads as the organization's (prepend tier)" grep -q "hooks module $ORG loaded (.*tier prepend" "$out/$s/debug.log"
  check "$s: capture on, live, at the policy's project, dataset, table and location" has "$s" "$TARGET" status.txt
  check "$s: no destination of the person's, the repository's or the shell's, and no dry run" lacks "$s" "$OTHERS" status.txt
  check "$s: the policy's token command runs; no token from the shell or the repository" has "$s" 'token command `echo` printed no access token' status.txt
  check "$s: rows wait in the default folder, none in the folders the others name" \
    bash -c "grep -q '^/home/dev/.bqaa-mod/dead-letter/example-project.team_dataset.team_events/' '$out/$s/files.txt' && ! grep -q '/home/dev/repo/' '$out/$s/files.txt'"
  check "$s: rows carry the policy's agent name, the login name and no host name" rows_are "$s" "$ROWS"
done
check 'partial: what the policy leaves out is the person'"'"'s (capture off, a dry run in their folder, their table)' \
  bash -c "grep -q 'disabled, target dry run -> /home/dev/repo/dry-run' '$out/partial/status.txt' && grep -q 'example-project.team_dataset.user_table' '$out/partial/status.txt'"
check 'unpinned: the shell and the repository turn capture off and a dry run on' has unpinned 'disabled, target dry run' status.txt
check 'migration: the earlier install records (its tracer hooks run, the mod loads under the old id)' \
  bash -c "grep -qx before-policy '$out/tracer-ran' && grep -q 'hooks module $OLD loaded' '$out/before-policy/debug.log'"
check 'migration: with the old ids left on, the tracer keeps writing beside the mod' \
  bash -c "grep -qx old-ids-left-on '$out/tracer-ran' && grep -q 'hooks module $ORG loaded' '$out/old-ids-left-on/debug.log'"
check 'migration: the mod under its old id never loads beside the organization'"'"'s' \
  grep -q "$OLD not loaded: another plugin of that name loads first" "$out/old-ids-left-on/debug.log"
check 'migration: with the old ids off, the tracer runs no hook' \
  bash -c "! grep -qx old-ids-off '$out/tracer-ran' && grep -q 'hooks module $ORG loaded' '$out/old-ids-off/debug.log'"
check 'migration: allowManagedModsOnly does not stop the tracer' \
  bash -c "grep -qx managed-mods-only '$out/tracer-ran' && grep -q 'hooks module $ORG loaded' '$out/managed-mods-only/debug.log'"
check 'migration: allowManagedHooksOnly stops the tracer and the old mod, not the organization'"'"'s' \
  bash -c "! grep -qx managed-hooks-only '$out/tracer-ran' && grep -q '$OLD not loaded: only managed plugins and built-in plugins run' '$out/managed-hooks-only/debug.log' && grep -q 'hooks module $ORG loaded' '$out/managed-hooks-only/debug.log'"
check 'opt-out: plugin uninstall is refused, with or without --scope managed' \
  bash -c "grep -qE 'installed in managed scope|not installed in user scope' '$out/uninstall.txt' && grep -q 'Invalid scope: managed' '$out/uninstall.txt'"
check 'migration: a policy false refuses a new install of the tracer' grep -q 'blocked by your organization' "$out/blocked-install.txt"
check 'rollback: removing the policy straight after the migration brings the tracer and the old mod back' \
  bash -c "grep -qx rollback-too-soon '$out/tracer-ran' && grep -q 'hooks module $OLD loaded' '$out/rollback-too-soon/debug.log'"
check 'rollback: the disable policy loads no mod and runs no tracer hook' \
  bash -c "test -s '$out/rollback-disabled/debug.log' && ! grep -qx rollback-disabled '$out/tracer-ran' && ! grep -q 'hooks module bigquery-agent-analytics-mod' '$out/rollback-disabled/debug.log'"
check 'rollback: once the earlier installs are uninstalled, removing the policy leaves nothing running' \
  bash -c "test -s '$out/rollback-done/debug.log' && ! grep -qx rollback-done '$out/tracer-ran' && ! grep -q 'hooks module bigquery-agent-analytics-mod' '$out/rollback-done/debug.log'"
check 'opt-out: after plugin disable and uninstall, and with the person'"'"'s enabledPlugins false, the mod still records' \
  has after-opt-out "$TARGET" status.txt
for s in safe-mode safe-mode-env bare; do
  check "opt-out: $s loads no plugin, the organization's included" not_loaded "$s" "$ORG"
done
check 'pins: the drop-in applies beside the existing managed-settings.json, whose env still reaches the session' grep -qx 'ORG_EXISTING=kept' "$out/token-env-direct.env"
check 'token env: a repository'"'"'s CLOUDSDK_PYTHON, CLOUDSDK_CONFIG, proxy, CA file, PYTHONPATH and PATH reach the token command' \
  bash -c "grep -qx 'CLOUDSDK_PYTHON=/tmp/evil-python' '$out/token-env-direct.env' && grep -qx 'HTTPS_PROXY=http://evil.invalid:3128' '$out/token-env-direct.env' && grep -qx 'CLOUDSDK_CONFIG=/tmp/evil-config' '$out/token-env-direct.env' && grep -q '^PATH=/tmp/evil-bin' '$out/token-env-direct.env'"
check 'token env: through the wrapper, the command gets only HOME, PATH and PWD' \
  bash -c "test -s '$out/token-env-wrapped.env' && ! grep -qvE '^(HOME=/home/dev|PATH=/usr/bin:/bin|PWD=.*)\$' '$out/token-env-wrapped.env'"
check 'token env: with the policy pinning them, gcloud'"'"'s variables reach the command empty' \
  bash -c "grep -qx 'CLOUDSDK_PYTHON=' '$out/token-env-pinned.env' && grep -qx 'HTTPS_PROXY=' '$out/token-env-pinned.env' && grep -qx 'CLOUDSDK_CONFIG=' '$out/token-env-pinned.env'"
check 'identity: a repository'"'"'s USER becomes user_id; its HOME does not move the rows' \
  bash -c "grep -q 'user_id=someone-else' '$out/repository-user/rows.txt' && grep -q '^/home/dev/.bqaa-mod/' '$out/repository-user/files.txt' && ! grep -q elsewhere '$out/repository-user/files.txt'"
check 'disable: the policy'"'"'s enabledPlugins false unloads the mod' not_loaded policy-off "$ORG"
check 'disable: the kill switch keeps it loaded, recording nothing' \
  bash -c "grep -q 'hooks module $ORG loaded' '$out/kill-switch/debug.log' && grep -q 'disabled, target' '$out/kill-switch/status.txt' && grep -q 'captured 0' '$out/kill-switch/status.txt'"
check 'rollback: with the policy gone, the rows left behind stay on disk' kept before-rollback rolled-back
check 'rollback: the mod did not load while the policy was gone' not_loaded rolled-back "$ORG"
check 'rollback: put back, the mod lists the rows still waiting' grep -q 'dead-letter: [1-9][0-9]* file(s)' "$out/restored/status.txt"
check 'rollback: the folder deleted, nothing waits' grep -q 'dead-letter: 0 file(s)' "$out/purged/status.txt"

if [[ "$network" == 1 ]]; then
  version="$PIN_VERSION"
  mkdir -p "$out/net"
  net="$out/net"
  docker run --rm -v "$work/in:/in:ro" -v "$net:/out" "$BQAA_CHECK_GIT_IMAGE" bash /in/github.sh >"$net/docker.log" 2>&1
  out="$net"
  check 'github: the container ran every networked scenario' test -f "$out/done"
  check 'github: a fresh machine records nothing in its first session' not_loaded github-1 "$OLD"
  check 'github: it records by its third, in the user tier' bash -c "grep -q 'hooks module $OLD loaded (.*tier user' '$out/github-3/debug.log' && grep -q 'not read in place from a local folder' '$out/github-3/debug.log'"
  check "github: the copy is the pinned ref's ($version), and autoUpdate stays off" bash -c "grep -q '/$version\$' '$out/github-3/copies.txt' && grep -q 'autoUpdate False' '$out/github-3/copies.txt'"
  check 'github: the policy'"'"'s options hold against the person'"'"'s' bash -c "grep -q '$TARGET' '$out/github-3/status.txt' && ! grep -qE '$OTHERS' '$out/github-3/status.txt'"
  check 'github: the token command needs no delivered file: env -i runs gcloud at its path with the guide'"'"'s arguments' \
    bash -c "grep -qx 'auth print-access-token --impersonate-service-account=bqaa-row-writer@example-project.iam.gserviceaccount.com' '$out/github-token-env/gcloud.args' && grep -q 'token command .env. printed no access token' '$out/github-token-env/status.txt'"
  check 'github: a repository'"'"'s settings env does not reach it: gcloud gets only PATH' \
    bash -c "test -s '$out/github-token-env/gcloud.env' && ! grep -qvE '^(PATH=/usr/bin:/bin|PWD=.*)\$' '$out/github-token-env/gcloud.env'"
  check 'github: rows carry the policy'"'"'s agent name, the login name and no host name' rows_are github-3 "$ROWS"
  check "github: one install from the pinned source records from the first session ($version)" bash -c "grep -q '$TARGET' '$out/pinned-install-1/status.txt' && grep -q '/$version\$' '$out/pinned-install-1/copies.txt'"
  check 'github: the person'"'"'s enabledPlugins false and plugin uninstall leave it on' bash -c "grep -qE 'installed in managed scope|not installed in user scope' '$out/github-uninstall.txt' && grep -q '$TARGET' '$out/github-after-opt-out/status.txt'"
  check 'github: allowManagedModsOnly refuses the copy' grep -q 'refused by cc-plugin-sec-default: mods are limited to your organization' "$out/github-managed-mods-only/debug.log"
  check 'github: allowManagedHooksOnly does not load the copy' not_loaded github-managed-hooks-only "$OLD"
  check 'github: with the policy removed, the copy stays installed and loads without the policy'"'"'s options' \
    bash -c "grep -q 'hooks module $OLD loaded' '$out/github-policy-removed/debug.log' && ! grep -q '$TARGET' '$out/github-policy-removed/status.txt'"
  check 'github: the disable policy does not load the copy' not_loaded github-disabled "$OLD"
  check 'github: uninstalled under the disable policy, the copy stays gone once the policy is removed' \
    bash -c "grep -q 'Successfully uninstalled' '$out/github-rollback-uninstall.txt' && test -s '$out/github-rollback-done/debug.log' && ! grep -q 'hooks module $OLD loaded' '$out/github-rollback-done/debug.log'"
fi

echo "$passed passed, $failed failed"
if ((failed > 0)); then
  echo "--- docker (offline)"; tail -20 "$work/out/docker.log" 2>/dev/null
  if [[ "$network" == 1 ]]; then echo "--- docker (github)"; tail -20 "$work/out/net/docker.log" 2>/dev/null; fi
fi
((failed == 0))
