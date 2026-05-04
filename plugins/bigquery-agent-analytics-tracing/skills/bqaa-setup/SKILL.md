---
name: bqaa-setup
description: Use this when the user wants to configure or bootstrap Google BigQuery Agent Analytics (BQAA) tracing for this project — enabling APIs, creating a service account, creating the agent_events dataset/table, and granting IAM. Triggers on phrases like "set up BQAA", "configure agent analytics", "bootstrap BQAA tracing", "prepare BigQuery for tracing", "wire up agent_events", "fix BQAA permissions", "why aren't my BQAA rows showing up", or after the user installs the bigquery-agent-analytics-tracing plugin and asks how to start emitting rows. Also use when an agent run is silently failing to write because BQAA env vars or IAM aren't set up.
---

# Set up BQAA tracing for this user

Goal: get agent-event rows flowing from this Claude Code session into a BigQuery `agent_events` table. The plugin's hooks already fire automatically once enabled — your job is to fill in the GCP/IAM gap. **Do not** mutate the user's GCP project without explicit approval at each step.

## What's already automatic vs. what isn't

After `claude plugin install bigquery-agent-analytics-tracing@…` and a Claude Code restart:

- **Automatic:** SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStop hooks fire and try to write rows.
- **Not automatic:** enabling GCP APIs, creating the BigQuery dataset/table, creating a service account, granting IAM, or running the bootstrap. The hook code calls `google-cloud-bigquery` directly — it never invokes `gcloud` or `bq`. If `BQAA_PROJECT_ID`/`BQAA_DATASET` are missing or IAM is wrong, every hook silently no-ops and writes the error to `BQAA_LOG_FILE` (default `/tmp/bqaa-agent-tracing.log`).

So if rows aren't showing up, you are almost always one of: (a) env vars unset, (b) ADC not configured, (c) IAM grants missing, (d) wrong dataset/location. This skill walks the user through fixing all four.

## Step 1 — Gather inputs (don't run anything yet)

Ask the user (or read from environment) and confirm before continuing:

| Input | Default / source | When to ask |
|---|---|---|
| GCP project ID | `$BQAA_PROJECT_ID`, `$GCP_PROJECT_ID`, `$GOOGLE_CLOUD_PROJECT`, or `gcloud config get-value project` | Always confirm — wrong project is the most expensive mistake |
| BigQuery dataset | `$BQAA_DATASET` or `agent_analytics` | Ask if multi-team or shared dataset |
| Table name | `$BQAA_TABLE` or `agent_events` | Rarely changed |
| Location | `$BQAA_LOCATION` or `US` | Ask if outside US (must match existing dataset if it exists) |
| Service account | `bqaa-writer` (creates `bqaa-writer@PROJECT.iam.gserviceaccount.com`) | Skip with `--principal user:NAME@example.com` if the agent runtime uses user ADC |

Echo the values back to the user before any subprocess call. Phrasing like "I'll set up BQAA tracing on `project-xyz` / dataset `agent_analytics` / location `US` with a `bqaa-writer` service account — sound right?" works.

## Step 2 — Check ADC

Run **only**:

```bash
gcloud auth application-default print-access-token >/dev/null 2>&1 && echo "ADC OK" || echo "ADC NOT CONFIGURED"
gcloud config get-value project 2>/dev/null
```

If ADC is not configured, **stop here**. Tell the user verbatim:

> ADC isn't configured — you'll need to run `gcloud auth application-default login` in your own terminal (it's an interactive browser flow that I can't complete for you). Reply when it's done and I'll continue.

Wait for them to confirm. Don't try `gcloud auth application-default login` yourself; the OAuth flow needs a browser the user controls.

## Step 3 — Dry-run the bootstrap

Always run dry-run first. Show the full plan to the user.

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "${BQAA_TABLE:-agent_events}" \
  --location "${BQAA_LOCATION:-US}" \
  --service-account bqaa-writer \
  --non-interactive
```

The script prints a numbered plan of every gcloud / bq / google-cloud-bigquery call it will make, plus a preflight summary of ADC + project. **Show the printed plan to the user verbatim** and ask: "Does this plan look right? Want me to apply it?"

Common variations the user may want:

- **User ADC instead of service account:** drop `--service-account bqaa-writer` and add `--principal "user:$(gcloud config get-value account)"`.
- **Existing dataset, don't touch it:** add `--no-create-dataset --no-create-table`.
- **Runtime auto-creates datasets:** add `--runtime-auto-create-dataset` to also grant `roles/bigquery.user`.

## Step 4 — Wait for explicit approval, then execute

Only after the user says yes (or equivalent), append `--execute`:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "${BQAA_TABLE:-agent_events}" \
  --location "${BQAA_LOCATION:-US}" \
  --service-account bqaa-writer \
  --non-interactive --execute
```

If a step fails (most often `Permission denied: serviceusage.services.enable` or IAM propagation latency), the script's own retry covers IAM propagation. For permission errors, tell the user which role they're missing — it's almost always one of:

- `roles/serviceusage.serviceUsageAdmin` to enable APIs
- `roles/iam.serviceAccountAdmin` to create the SA
- `roles/bigquery.admin` (or `dataOwner` on dataset + `jobUser` on project) to create dataset / set IAM

## Step 5 — Verify with a real BigQuery round-trip

Run the e2e smoke once `--execute` returns 0:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_bigquery_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "${BQAA_TABLE:-agent_events}" \
  --location "${BQAA_LOCATION:-US}"
```

Expected: JSON output ends with `"missing_event_types": []` and `"row_count": 4`. Show the user the four event types written.

## Step 6 — Wire the env so future Claude Code sessions auto-trace

Persist `BQAA_*` so the plugin's hooks find them. Two options — let the user choose:

1. **Project-scoped** (recommended): write to `.claude/settings.local.json` `env` block in this repo. This file is gitignored.
2. **User-scoped**: export from `~/.zshrc` / `~/.bashrc`.

Required keys: `BQAA_PROJECT_ID`, `BQAA_DATASET`, `BQAA_LOCATION`. Optional: `BQAA_TABLE`, `BQAA_AGENT_NAME`, `BQAA_WRITER_LABEL` (use a per-team / per-product suffix like `bqaa-coding-agent-plugin/0.1.0/team-foo` so adoption queries can break down by deployment).

Tell the user: "Restart Claude Code in this directory to pick up the env. The next session's hooks will write rows automatically."

## Step 7 — Sanity query (optional)

Once the next session has been used, suggest the adoption query:

```sql
SELECT JSON_VALUE(attributes, '$.writer.agent') AS agent,
       JSON_VALUE(attributes, '$.writer.label') AS writer_label,
       COUNT(*) AS events,
       COUNT(DISTINCT session_id) AS sessions
FROM `<PROJECT>.<DATASET>.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
GROUP BY agent, writer_label
ORDER BY events DESC
```

If `agent='claude-code'` rows appear, the loop is closed.

## Troubleshooting jumps

If the user says "no rows", "rows not landing", "stuck", check in this order:

1. `cat /tmp/bqaa-agent-tracing.log` — last few lines have the actual error.
2. `ls /tmp/bqaa-agent-tracing/spool/dead-letter/` — permanent failures live here as JSON.
3. `bq query --use_legacy_sql=false "SELECT COUNT(*) FROM \`<PROJECT>.<DATASET>.agent_events\` WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 5 MINUTE)"` — proves whether anything has landed.
4. If env vars look right but no rows, run the e2e smoke (Step 5) — it bypasses spool/drainer and writes inline, so it tells you whether IAM is the issue independent of the hook plumbing.

## What NOT to do

- Don't run `gcloud auth login` or `application-default login` yourself — they're interactive browser flows.
- Don't run `--execute` without showing the dry-run plan first.
- Don't grant `roles/bigquery.admin` "to be safe" — the bootstrap defaults to the narrow runtime roles (`dataEditor` on dataset + `jobUser` on project) for a reason.
- Don't generate service-account JSON keys. ADC + impersonation is the safer default; if the user insists, point them at Workload Identity Federation instead.
