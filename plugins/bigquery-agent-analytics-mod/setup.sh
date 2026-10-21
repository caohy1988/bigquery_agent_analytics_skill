#!/usr/bin/env bash
# Creates what the mod writes to, and the usage views over it, with the bq CLI:
#   1. The dataset for the events table, when it is missing, in BQAA_LOCATION.
#   2. The events table from sql/agent_events_ddl.sql (BQAA schema v2,
#      partitioned by day on timestamp, clustered on event_type, agent and
#      user_id) when it is missing, and its event_id column.
#   3. A second dataset for the views (default <dataset>_reporting): people
#      who read the views then need no access to the table, and the
#      identities that write rows none to the views.
#   4. The views in sql/views/: daily_usage_by_model and daily_usage_by_user.
#
# With --service-account NAME, also a writer service account that people
# impersonate, so none of them needs access to the table and no key is kept
# (docs/service-account-auth.md):
#   5. The service account NAME@<project>.iam.gserviceaccount.com, when it is
#      missing.
#   6. The project's custom role bqaaRowWriter, or the permissions it lacks:
#      it may insert rows into a table (bigquery.tables.updateData, and
#      bigquery.tables.get, which streaming inserts also check) and read no
#      rows.
#   7. That role for the service account, on the events table alone.
#   8. roles/iam.serviceAccountTokenCreator on the service account for each
#      --token-creator MEMBER, best a group (group:team@example.com).
#
# Safe to run again: it creates what is missing, replaces the two views and
# removes nothing. --dry-run prints the commands and the SQL and runs none.
#
# Usage:
#   BQAA_PROJECT_ID=my-project BQAA_DATASET=agent_analytics ./setup.sh [--dry-run]
#     [--service-account NAME [--token-creator MEMBER]...]
#
# Settings, read from the same environment variables as the mod:
#   BQAA_PROJECT_ID     the project (or GCP_PROJECT_ID, GOOGLE_CLOUD_PROJECT)
#   BQAA_DATASET        the dataset of the events table (or BQ_DATASET)
#   BQAA_TABLE          the events table (or BQ_TABLE; default agent_events)
#   BQAA_LOCATION       where new datasets go (default US)
#   BQAA_VIEWS_DATASET  the dataset of the views (default <dataset>_reporting)
#
# Needs the bq CLI, signed in as someone who may create datasets, tables and
# views in the project; with --service-account, also gcloud, signed in as
# someone who may create service accounts and roles and set their policies.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage_error() {
  echo "setup.sh: $* (try --help)" >&2
  exit 2
}

dry_run=0
service_account=""
token_creators=()
while (($#)); do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --service-account)
      (($# >= 2)) || usage_error "--service-account needs a name"
      service_account="$2"
      shift
      ;;
    --service-account=*) service_account="${1#*=}" ;;
    --token-creator)
      (($# >= 2)) || usage_error "--token-creator needs a member"
      token_creators+=("$2")
      shift
      ;;
    --token-creator=*) token_creators+=("${1#*=}") ;;
    -h | --help)
      sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) usage_error "unknown argument \"$1\"" ;;
  esac
  shift
done
# An empty array is "unbound" to bash 3.2 under set -u: this expands to
# nothing then.
creators=(${token_creators[@]+"${token_creators[@]}"})
if ((${#creators[@]} > 0)) && [[ -z "$service_account" ]]; then
  usage_error "--token-creator goes with --service-account"
fi

project="${BQAA_PROJECT_ID:-${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}}"
dataset="${BQAA_DATASET:-${BQ_DATASET:-}}"
table="${BQAA_TABLE:-${BQ_TABLE:-agent_events}}"
location="${BQAA_LOCATION:-US}"
views_dataset="${BQAA_VIEWS_DATASET:-${dataset}_reporting}"

fail() {
  echo "setup.sh: $*" >&2
  exit 1
}

[[ -n "$project" ]] || fail "set BQAA_PROJECT_ID to the project that holds the dataset"
[[ -n "$dataset" ]] || fail "set BQAA_DATASET to the dataset for the events table"
# The names go into SQL and into sed patterns, so only plain ones are taken.
# A project id is 6 to 30 lowercase letters, digits and hyphens, starting with
# a letter; a domain-scoped one has its domain and a colon in front.
[[ "$project" =~ ^([a-z0-9.-]+:)?[a-z][-a-z0-9]{4,28}[a-z0-9]$ ]] || fail "BQAA_PROJECT_ID \"$project\" is not a project id"
for name in "$dataset" "$table" "$views_dataset"; do
  [[ "$name" =~ ^[A-Za-z0-9_]+$ && ${#name} -le 1024 ]] || fail "\"$name\" is not a plain dataset or table name (letters, digits and underscores)"
done
[[ "$location" =~ ^[A-Za-z0-9-]+$ ]] || fail "BQAA_LOCATION \"$location\" is not a location"
if [[ -n "$service_account" ]]; then
  # A service account id is 6 to 30 lowercase letters, digits and hyphens,
  # starting with a letter. A member is a principal type and an address.
  [[ "$service_account" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || fail "\"$service_account\" is not a service account name (6 to 30 lowercase letters, digits and hyphens, starting with a letter)"
  for member in ${creators[@]+"${creators[@]}"}; do
    [[ "$member" =~ ^(user|group|serviceAccount|domain):[A-Za-z0-9._%+@-]+$ ]] || fail "\"$member\" is not a member (user:, group:, serviceAccount: or domain: and an address)"
  done
  # A domain-scoped project (example.com:my-project) names its service
  # accounts my-project.example.com.
  if [[ "$project" == *:* ]]; then
    sa_email="$service_account@${project#*:}.${project%%:*}.iam.gserviceaccount.com"
  else
    sa_email="$service_account@$project.iam.gserviceaccount.com"
  fi
  writer_role="projects/$project/roles/bqaaRowWriter"
  # Streaming inserts check bigquery.tables.get as well as updateData
  # ("Permission bigquery.tables.get denied on table" without it).
  writer_permissions="bigquery.tables.get,bigquery.tables.updateData"
fi

# A SQL file with its placeholders filled in.
render() {
  sed -e "s/{PROJECT}/${project}/g" \
    -e "s/{VIEWS_DATASET}/${views_dataset}/g" \
    -e "s/{DATASET}/${dataset}/g" \
    -e "s/{TABLE}/${table}/g" \
    "$1"
}

# Runs a SQL file as one standard-SQL script, or prints it.
query() {
  local sql
  sql="$(render "$1")"
  if ((dry_run)); then
    printf '+ bq --project_id=%s query --use_legacy_sql=false --location=%s <<SQL\n%s\nSQL\n' "$project" "$location" "$sql"
  else
    printf '%s\n' "$sql" | bq --project_id="$project" query --use_legacy_sql=false --location="$location" >/dev/null
  fi
}

# Creates a dataset unless it exists.
dataset_ready() {
  if ((dry_run)); then
    printf '+ bq --project_id=%s show --dataset %s:%s || bq --project_id=%s --location=%s mk --dataset --description=%q %s:%s\n' \
      "$project" "$project" "$1" "$project" "$location" "$2" "$project" "$1"
  elif bq --project_id="$project" show --dataset "$project:$1" >/dev/null 2>&1; then
    echo "==> $project:$1 is there already"
  else
    echo "==> $project:$1 is missing: making it, in $location"
    bq --project_id="$project" --location="$location" mk --dataset --description="$2" "$project:$1" >/dev/null
  fi
}

# A command as one shell line, each word quoted.
quoted() {
  printf '%q' "$1"
  shift
  printf ' %q' "$@"
}

# Runs a command, or prints it.
run() {
  if ((dry_run)); then
    printf '+ %s\n' "$(quoted "$@")"
  else
    "$@" >/dev/null
  fi
}

# Creates the writer service account unless it exists.
service_account_ready() {
  if ((dry_run)); then
    printf '+ %s || %s\n' "$(quoted gcloud iam service-accounts describe "$sa_email" --project="$project")" \
      "$(quoted gcloud iam service-accounts create "$service_account" --project="$project" \
        --display-name="BigQuery Agent Analytics mod writer" \
        --description="Inserts the mod's rows into $project:$dataset.$table; people impersonate it")"
  elif gcloud iam service-accounts describe "$sa_email" --project="$project" >/dev/null 2>&1; then
    echo "==> Service account $sa_email is there already"
  else
    echo "==> Service account $sa_email is missing: making it"
    run gcloud iam service-accounts create "$service_account" --project="$project" \
      --display-name="BigQuery Agent Analytics mod writer" \
      --description="Inserts the mod's rows into $project:$dataset.$table; people impersonate it"
  fi
}

# Creates the row-writer role, or adds the permissions it lacks.
writer_role_ready() {
  if ((dry_run)); then
    printf '+ %s && %s || %s\n' "$(quoted gcloud iam roles describe bqaaRowWriter --project="$project")" \
      "$(quoted gcloud iam roles update bqaaRowWriter --project="$project" --add-permissions="$writer_permissions" --quiet)" \
      "$(quoted gcloud iam roles create bqaaRowWriter --project="$project" \
        --title="BigQuery Agent Analytics row writer" \
        --description="Inserts rows into the tables it is granted on, and reads none" \
        --permissions="$writer_permissions" --stage=GA)"
  elif gcloud iam roles describe bqaaRowWriter --project="$project" >/dev/null 2>&1; then
    echo "==> Role $writer_role is there already: making sure it has $writer_permissions"
    run gcloud iam roles update bqaaRowWriter --project="$project" --add-permissions="$writer_permissions" --quiet
  else
    echo "==> Role $writer_role is missing: making it ($writer_permissions)"
    run gcloud iam roles create bqaaRowWriter --project="$project" \
      --title="BigQuery Agent Analytics row writer" \
      --description="Inserts rows into the tables it is granted on, and reads none" \
      --permissions="$writer_permissions" --stage=GA
  fi
}

# Runs a binding, tried again for a minute: a service account made moments
# ago is not yet one IAM accepts as a member everywhere.
bind() {
  local try
  if ((dry_run)); then
    run "$@"
    return
  fi
  for try in 1 2 3 4 5 6 7; do
    if "$@" >/dev/null 2>&1; then return 0; fi
    ((try < 7)) && sleep 10
  done
  "$@" >/dev/null
}

echo "==> $project: table $dataset.$table, views in $views_dataset"
if ((dry_run)); then echo "==> Dry run: nothing is created"; fi

dataset_ready "$dataset" "BigQuery Agent Analytics events written by the bigquery-agent-analytics-mod coding-agent mod"
echo "==> Table $dataset.$table (created if missing)"
query "$here/sql/agent_events_ddl.sql"

dataset_ready "$views_dataset" "Usage views over $project.$dataset.$table"
for view in daily_usage_by_model daily_usage_by_user; do
  echo "==> View $views_dataset.$view"
  query "$here/sql/views/$view.sql"
done

if [[ -n "$service_account" ]]; then
  service_account_ready
  writer_role_ready
  echo "==> $writer_role for $sa_email on $dataset.$table"
  bind bq --project_id="$project" add-iam-policy-binding \
    --member="serviceAccount:$sa_email" --role="$writer_role" "$project:$dataset.$table"
  for member in ${creators[@]+"${creators[@]}"}; do
    echo "==> roles/iam.serviceAccountTokenCreator on $sa_email for $member"
    bind gcloud iam service-accounts add-iam-policy-binding "$sa_email" --project="$project" \
      --member="$member" --role=roles/iam.serviceAccountTokenCreator
  done
fi

echo
echo "Done. The mod writes to $project.$dataset.$table with these options:"
echo "  project: $project"
echo "  dataset: $dataset"
if [[ "$table" != agent_events ]]; then echo "  table: $table"; fi
if [[ -n "$service_account" ]]; then
  echo "  accessTokenCommand: gcloud auth print-access-token --impersonate-service-account=$sa_email"
  echo "Rows are inserted as $sa_email. Each person signs in to gcloud once"
  echo "(gcloud auth login) and needs roles/iam.serviceAccountTokenCreator on it."
  echo "Leave userIdFromCredentials off: with it on, user_id would be the service account."
else
  echo "Writers need to insert rows into $project:$dataset.$table: roles/bigquery.dataEditor"
  echo "on $project:$dataset, or the row-writer role --service-account sets up."
fi
echo "Readers of the views need roles/bigquery.dataViewer on $project:$views_dataset"
echo "(authorize the views on $project:$dataset to keep them off the table) and"
echo "roles/bigquery.jobUser."
