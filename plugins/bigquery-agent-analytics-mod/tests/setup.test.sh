#!/usr/bin/env bash
# Offline test of setup.sh: stand-ins for `bq` and `gcloud` on PATH log every
# call (and the SQL each query reads) to one file, so nothing reaches Google
# Cloud and the order of the calls shows. Run from anywhere:
#   bash tests/setup.test.sh
set -euo pipefail

plugin="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
cat >"$work/bin/bq" <<'BQ'
#!/usr/bin/env bash
# Logs its arguments, and for a query the SQL it reads; `show` finds a
# dataset only if it is listed in $BQ_EXISTING.
printf 'bq %s\n' "$*" >>"$BQ_LOG"
for arg in "$@"; do
  if [[ "$arg" == query ]]; then { echo '--- sql'; cat; echo '--- end'; } >>"$BQ_LOG"; fi
done
if [[ " $* " == *" show "* ]]; then
  for name in ${BQ_EXISTING:-}; do [[ " $* " == *":$name "* || "$*" == *":$name" ]] && exit 0; done
  exit 1
fi
exit 0
BQ
chmod +x "$work/bin/bq"
cat >"$work/bin/gcloud" <<'GCLOUD'
#!/usr/bin/env bash
# Logs its arguments; `describe` finds a service account or role only if it
# is listed in $GCLOUD_EXISTING.
printf 'gcloud %s\n' "$*" >>"$BQ_LOG"
if [[ " $* " == *" describe "* ]]; then
  for name in ${GCLOUD_EXISTING:-}; do [[ " $* " == *" $name "* ]] && exit 0; done
  exit 1
fi
exit 0
GCLOUD
chmod +x "$work/bin/gcloud"

passed=0
failed=0
check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then passed=$((passed + 1)); echo "ok - $what"; else failed=$((failed + 1)); echo "not ok - $what"; fi
}
has() { grep -qF -- "$1" "$2"; }
lacks() { ! grep -qF -- "$1" "$2"; }

run_setup() { # log file, then environment assignments, then setup.sh arguments
  local log="$1"
  shift
  : >"$log"
  env -i PATH="$work/bin:/usr/bin:/bin" BQ_LOG="$log" "$@" bash "$plugin/setup.sh" ${SETUP_ARGS:-} >"$log.out" 2>"$log.err"
}

# 1. A first run creates both datasets, the table and the two views.
log="$work/first.log"
check 'a first run succeeds' run_setup "$log" BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics
check 'it creates the events dataset in US' has 'bq --project_id=my-gcp-project --location=US mk --dataset' "$log"
check 'it creates the views dataset' has 'my-gcp-project:agent_analytics_reporting' "$log"
check 'the table DDL names the table' has 'CREATE TABLE IF NOT EXISTS `my-gcp-project.agent_analytics.agent_events`' "$log"
check 'the table gets its event_id column' has 'ADD COLUMN IF NOT EXISTS event_id STRING' "$log"
check 'the model view is made in the views dataset' has 'CREATE OR REPLACE VIEW `my-gcp-project.agent_analytics_reporting.daily_usage_by_model`' "$log"
check 'the user view is made in the views dataset' has 'CREATE OR REPLACE VIEW `my-gcp-project.agent_analytics_reporting.daily_usage_by_user`' "$log"
check 'the views read the events table' has 'FROM `my-gcp-project.agent_analytics.agent_events`' "$log"
check "the views keep to this mod's rows" test "$(grep -cF "AND JSON_VALUE(attributes, '\$.writer.plugin') = 'bigquery-agent-analytics-mod'" "$log")" -eq 2
check 'no placeholder is left' lacks '{' "$log"
check 'queries are standard SQL in the location' has 'query --use_legacy_sql=false --location=US' "$log"
check 'three queries in all: the table, then the two views' test "$(grep -c -- '--- sql' "$log")" -eq 3

# 2. Run again with both datasets there: nothing is made but the views.
log="$work/again.log"
check 'a second run succeeds' run_setup "$log" BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics BQ_EXISTING='agent_analytics agent_analytics_reporting'
check 'no dataset is created again' lacks 'mk --dataset' "$log"
check 'the table DDL runs again (CREATE ... IF NOT EXISTS)' has 'CREATE TABLE IF NOT EXISTS' "$log"

# 3. Other names, and the fallbacks the mod reads.
log="$work/names.log"
check 'fallback variables and a views dataset of its own' run_setup "$log" GOOGLE_CLOUD_PROJECT=other-project BQ_DATASET=events BQ_TABLE=coding_events BQAA_LOCATION=EU BQAA_VIEWS_DATASET=reports
check 'the table comes from BQ_TABLE' has '`other-project.events.coding_events`' "$log"
check 'the views go to BQAA_VIEWS_DATASET' has '`other-project.reports.daily_usage_by_model`' "$log"
check 'the location is EU' has '--location=EU mk --dataset' "$log"
check 'the table option is printed when not the default' has '  table: coding_events' "$log.out"

# 4. A dry run calls bq for nothing and prints the SQL.
log="$work/dry.log"
check 'a dry run succeeds' env SETUP_ARGS=--dry-run bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; run_setup '$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics"
check 'a dry run makes no bq call' test ! -s "$log"
check 'a dry run prints the view SQL' has 'CREATE OR REPLACE VIEW `my-gcp-project.agent_analytics_reporting.daily_usage_by_model`' "$log.out"

# 5. Names that are not plain names, and missing settings, stop it before any call.
for bad in 'BQAA_DATASET=x;DROP' 'BQAA_DATASET=a.b' 'BQAA_TABLE=t`s' 'BQAA_VIEWS_DATASET=v-w' 'BQAA_PROJECT_ID=My_Project' 'BQAA_LOCATION=us east'; do
  log="$work/bad.log"
  check "refused: $bad" bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; ! run_setup '$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics '$bad'"
  check "no bq call for: $bad" test ! -s "$log"
done
log="$work/none.log"
check 'no project: refused' bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; ! run_setup '$log' BQAA_DATASET=agent_analytics"
check 'no project: says which variable' has 'set BQAA_PROJECT_ID' "$log.err"
check 'an unknown argument is refused' bash -c "! bash '$plugin/setup.sh' --force 2>/dev/null"

# 6. The command the mod prints when BigQuery cannot find the dataset (the
# shape tests/destination.test.ts holds it to) sets every name setup.sh
# reads: a views dataset, project, dataset or table already set in the shell
# that runs it, valid or not, changes nothing.
printed="BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics BQAA_TABLE=agent_events BQAA_VIEWS_DATASET=agent_analytics_reporting BQAA_LOCATION=US bash '$plugin/setup.sh'"
for inherited in ambient_reports v-w; do
  log="$work/printed-$inherited.log"
  : >"$log"
  check "the printed command runs with BQAA_VIEWS_DATASET=$inherited in the shell" env -i PATH="$work/bin:/usr/bin:/bin" BQ_LOG="$log" BQAA_VIEWS_DATASET="$inherited" GCP_PROJECT_ID=other-project BQ_DATASET=other_dataset BQ_TABLE=other_table bash -c "$printed >'$log.out' 2>'$log.err'"
  check "  its views go to agent_analytics_reporting" has 'CREATE OR REPLACE VIEW `my-gcp-project.agent_analytics_reporting.daily_usage_by_user`' "$log"
  check "  nothing goes to $inherited" lacks "$inherited" "$log"
  check "  nothing goes to the shell's project, dataset or table" bash -c "! grep -qE 'other-project|other_dataset|other_table' '$log'"
done

# 7. --service-account: the writer service account, the row-writer role, its
# binding on the table alone, and the token creators; then the option to set.
sa=bqaa-writer@my-gcp-project.iam.gserviceaccount.com
log="$work/sa.log"
check 'with --service-account and two token creators, a first run succeeds' env SETUP_ARGS="--service-account bqaa-writer --token-creator group:bqaa-team@example.com --token-creator=user:lead@example.com" bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; run_setup '$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics"
check 'it creates the service account' has 'gcloud iam service-accounts create bqaa-writer --project=my-gcp-project' "$log"
check 'it creates the role with the two permissions streaming inserts check' has 'gcloud iam roles create bqaaRowWriter --project=my-gcp-project --title=BigQuery Agent Analytics row writer --description=Inserts rows into the tables it is granted on, and reads none --permissions=bigquery.tables.get,bigquery.tables.updateData --stage=GA' "$log"
check 'it binds the role to the service account on the events table alone' has "bq --project_id=my-gcp-project add-iam-policy-binding --member=serviceAccount:$sa --role=projects/my-gcp-project/roles/bqaaRowWriter my-gcp-project:agent_analytics.agent_events" "$log"
check 'it grants token creation to the group' has "gcloud iam service-accounts add-iam-policy-binding $sa --project=my-gcp-project --member=group:bqaa-team@example.com --role=roles/iam.serviceAccountTokenCreator" "$log"
check 'and to the person (--token-creator=...)' has "--member=user:lead@example.com --role=roles/iam.serviceAccountTokenCreator" "$log"
check 'the binding comes after the table is made' test "$(grep -n 'CREATE TABLE IF NOT EXISTS' "$log" | head -1 | cut -d: -f1)" -lt "$(grep -n 'add-iam-policy-binding --member=serviceAccount' "$log" | cut -d: -f1)"
check 'no project-wide grant' lacks 'gcloud projects add-iam-policy-binding' "$log"
check 'it prints the token command to set' has "  accessTokenCommand: gcloud auth print-access-token --impersonate-service-account=$sa" "$log.out"
check 'it says to leave userIdFromCredentials off' has 'Leave userIdFromCredentials off' "$log.out"

# 8. Run again with the service account and role there: nothing is created,
# and the role gets any permission it lacks.
log="$work/sa-again.log"
check 'a second --service-account run succeeds' env SETUP_ARGS="--service-account bqaa-writer" bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; run_setup '$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics BQ_EXISTING='agent_analytics agent_analytics_reporting' GCLOUD_EXISTING='$sa bqaaRowWriter'"
check 'no service account is created again' lacks 'service-accounts create' "$log"
check 'no role is created again' lacks 'roles create' "$log"
check 'the role gets the permissions it lacks' has 'gcloud iam roles update bqaaRowWriter --project=my-gcp-project --add-permissions=bigquery.tables.get,bigquery.tables.updateData --quiet' "$log"
check 'the table binding runs again (adding it twice changes nothing)' has 'add-iam-policy-binding --member=serviceAccount:' "$log"

# 9. A domain-scoped project names its service accounts after the domain.
log="$work/sa-domain.log"
check 'a domain-scoped project' env SETUP_ARGS="--service-account bqaa-writer" bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; run_setup '$log' BQAA_PROJECT_ID=example.com:my-project BQAA_DATASET=agent_analytics"
check '  its service account is bqaa-writer@my-project.example.com.iam.gserviceaccount.com' has 'serviceAccount:bqaa-writer@my-project.example.com.iam.gserviceaccount.com' "$log"

# 10. A dry run with --service-account calls nothing and prints the commands.
log="$work/sa-dry.log"
check 'a --service-account dry run succeeds' env SETUP_ARGS="--dry-run --service-account bqaa-writer --token-creator group:bqaa-team@example.com" bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; run_setup '$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics"
check '  it makes no call' test ! -s "$log"
check '  it prints the role command' has 'gcloud iam roles create bqaaRowWriter' "$log.out"
check '  it prints the token creator binding' has 'roles/iam.serviceAccountTokenCreator' "$log.out"

# 11. Names that are not a service account or a member, and a token creator
# with no service account, stop it before any call.
for bad in '--service-account Bqaa_Writer' '--service-account abc' '--service-account bqaa;rm' '--service-account' '--service-account bqaa-writer --token-creator lead@example.com' '--service-account bqaa-writer --token-creator group:team/x' '--token-creator group:bqaa-team@example.com'; do
  log="$work/sa-bad.log"
  check "refused: $bad" env SETUP_ARGS="$bad" bash -c "$(declare -f run_setup); work='$work'; plugin='$plugin'; ! run_setup '$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics"
  check "no call for: $bad" test ! -s "$log"
done

log="$work/sa-space.log"
: >"$log"
check "refused: a member with a space in it" bash -c "! env -i PATH='$work/bin:/usr/bin:/bin' BQ_LOG='$log' BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics bash '$plugin/setup.sh' --service-account bqaa-writer --token-creator 'group:a b' 2>'$log.err'"
check "  it says the member is not one" has 'is not a member' "$log.err"
check "  no call for it" test ! -s "$log"

echo "$passed passed, $failed failed"
((failed == 0))
