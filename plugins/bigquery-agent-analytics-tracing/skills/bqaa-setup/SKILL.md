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
| Identity to grant (the **principal**) | `user:$(gcloud config get-value account)` (the user's own account) | See "Choosing the principal" below |
| Consumer | Ask: Claude Code TUI, Claude Agent SDK (Python), or Codex CLI? | Always ask — Step 6 emits different config for each |

### Choosing the principal

The default for local Claude Code / SDK / Codex on a developer workstation is
**`--principal user:$(gcloud config get-value account)`** — grant the developer's
own Google identity. Why: the BQAA hooks read ADC, and ADC == that same identity
on a normal `gcloud auth application-default login` setup. No impersonation, no
extra wiring; runtime "just works" once env is set in Step 6.

A **service account** (`--service-account bqaa-writer`) is the right choice
when:

- Multiple developers / a shared workstation will share the same writer identity.
- The agent will run unattended on a server / GKE / CI where there's no human
  to OAuth.
- Your org centralizes credential management on SAs.

If you go that route, the hooks will *not* automatically use the SA — ADC is
still whoever is logged in. You have to pick one of these to actually route
runtime traffic through the SA:

```bash
# Option A — SA impersonation via ADC (recommended, no JSON key):
gcloud auth application-default login \
  --impersonate-service-account=bqaa-writer@PROJECT.iam.gserviceaccount.com
# Caller still needs roles/iam.serviceAccountTokenCreator on the SA.

# Option B — gcloud-level impersonation (also affects gcloud commands):
gcloud config set auth/impersonate_service_account \
  bqaa-writer@PROJECT.iam.gserviceaccount.com

# Option C — service-account JSON key (least preferred; rotate on schedule):
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/bqaa-writer.json
```

If the user picked the SA path without picking A/B/C, **stop and tell them**
the SA was created and granted but the runtime hooks will keep using their own
identity until impersonation/key is wired. Most local-dev users should just
take the user-principal default.

Echo the values back to the user before any subprocess call. Phrasing like
"I'll set up BQAA tracing on `project-xyz` / dataset `agent_analytics` /
location `US`, granting your own account `you@example.com` (so local Claude
Code's ADC writes directly) — sound right?" works.

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

**Default (recommended for local Claude Code / SDK / Codex on a workstation):**

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "${BQAA_TABLE:-agent_events}" \
  --location "${BQAA_LOCATION:-US}" \
  --principal "user:$(gcloud config get-value account)" \
  --non-interactive
```

**Service-account path** (advanced — only when user opted in per Step 1; remind
them they still need to wire impersonation/key per Step 1's Option A/B/C):

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "${BQAA_TABLE:-agent_events}" \
  --location "${BQAA_LOCATION:-US}" \
  --service-account bqaa-writer \
  --non-interactive
```

The script prints a numbered plan of every gcloud / bq / google-cloud-bigquery
call it will make, plus a preflight summary of ADC + gcloud CLI auth +
project. **Show the printed plan to the user verbatim** and ask: "Does this
plan look right? Want me to apply it?"

Common variations:

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

## Step 6 — Wire the env so the consumer auto-traces

Required keys: `BQAA_PROJECT_ID`, `BQAA_DATASET`, `BQAA_LOCATION`. Optional but
recommended: `BQAA_TABLE`, `BQAA_AGENT_NAME`, `BQAA_WRITER_LABEL` (use a
per-team / per-product suffix like `bqaa-coding-agent-plugin/0.1.0/team-foo`
so adoption queries can break down by deployment).

The "right place" depends on the consumer the user chose in Step 1.
**Don't pick one for them.** Emit the snippet that fits and tell them how to
apply it.

### If the consumer is Claude Code TUI

Project-scoped is best — `.claude/settings.local.json` is gitignored and only
this repo gets the env. Write or update the `env` block:

```json
{
  "env": {
    "BQAA_PROJECT_ID": "<PROJECT>",
    "BQAA_DATASET": "<DATASET>",
    "BQAA_TABLE": "agent_events",
    "BQAA_LOCATION": "<LOCATION>",
    "BQAA_AGENT_NAME": "claude-code",
    "BQAA_WRITER_LABEL": "bqaa-coding-agent-plugin/0.1.0/<deployment>"
  },
  "permissions": { "...": "...preserve any existing block..." }
}
```

Use the `Edit` tool (not `Write`) if the file already has other settings so
you don't clobber existing `permissions` / `enabledPlugins` / etc. Hand-off:
*"Restart Claude Code in this directory to pick up the env."*

### If the consumer is Claude Agent SDK (Python)

Settings.local.json is **not** read by the SDK. The SDK spawns its own
`claude` subprocess with the `env` you pass via `ClaudeAgentOptions`. Emit:

```python
import os
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

options = ClaudeAgentOptions(
    cwd="<your-project-path>",
    env={
        **os.environ,
        "BQAA_PROJECT_ID": "<PROJECT>",
        "BQAA_DATASET": "<DATASET>",
        "BQAA_TABLE": "agent_events",
        "BQAA_LOCATION": "<LOCATION>",
        "BQAA_AGENT_NAME": "claude-agent-sdk",
        "BQAA_WRITER_LABEL": "bqaa-coding-agent-plugin/0.1.0/<deployment>",
    },
    plugins=[{"type": "local",
              "path": "<absolute-path-to>/plugins/bigquery-agent-analytics-tracing"}],
)
async with ClaudeSDKClient(options=options) as client:
    ...
```

Hand-off: *"Use this options block on every `ClaudeSDKClient`. The SDK does
not inherit your shell env — every `BQAA_*` must be in `options.env`."*

### If the consumer is Codex CLI (`bqaa-codex` wrapper)

Shell-scoped is the only path. Emit:

```bash
export BQAA_PROJECT_ID="<PROJECT>"
export BQAA_DATASET="<DATASET>"
export BQAA_TABLE="agent_events"
export BQAA_LOCATION="<LOCATION>"
export BQAA_AGENT_NAME="codex-cli"
export BQAA_WRITER_LABEL="bqaa-coding-agent-plugin/0.1.0/<deployment>"
```

Tell the user: "Add these to `~/.zshrc` / `~/.bashrc` and restart your shell,
or source them in the same terminal where you'll run
`bqaa-codex`. Then run a real `codex exec` through the wrapper and re-check
BigQuery."

### Python runtime caveat (all consumers)

The plugin's hooks shell out to `bash hook.sh`, which runs
`${BQAA_PYTHON:-python3}`. Whatever Python that resolves to **must** have
`google-cloud-bigquery` (and ideally `google-cloud-bigquery-storage` and
`pyarrow`) importable. If the user installed deps in a venv, point hooks at
that interpreter:

```bash
export BQAA_PYTHON="/path/to/venv/bin/python"
```

Add `BQAA_PYTHON` to the env block too (settings.local.json env or
ClaudeAgentOptions.env or shell). When verifying in Step 5/7, if rows aren't
landing despite IAM looking right, check `cat /tmp/bqaa-agent-tracing.log` —
`ModuleNotFoundError: google.cloud.bigquery` is the dead giveaway.

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
