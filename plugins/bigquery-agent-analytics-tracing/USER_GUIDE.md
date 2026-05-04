# BigQuery Agent Analytics Tracing User Guide

This guide covers how users get the tracing plugin, configure BigQuery, and
start emitting rows for each supported producer.

## Supported Channels

| Channel | Distribution | Runtime integration |
| --- | --- | --- |
| Claude Code | Claude plugin marketplace in this repo | Native Claude hook plugin |
| Claude Agent SDK (Python) | Same Claude plugin in this repo, loaded via `ClaudeAgentOptions` | Native Claude hook plugin in the SDK-spawned `claude` subprocess |
| Codex CLI | Wrapper command in this repo | `codex exec --json` JSONL stream |
| OpenAI Agents SDK | Python module in this repo | `TracingProcessor` via `add_trace_processor()` |
| Other Python agents | Python SDK module in this repo | Direct logger calls |

## 1. Prepare BigQuery

Use an existing ADK BigQuery Agent Analytics table, or let the logger create
the table on first write.

Required:

```bash
export BQAA_PROJECT_ID="your-gcp-project"
export BQAA_DATASET="agent_analytics"
export BQAA_TABLE="agent_events"
export BQAA_LOCATION="US"
```

Authentication:

```bash
gcloud auth application-default login
```

Or use a service account:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

The identity needs dataset write access. For auto-create behavior, it also
needs permission to create tables, and optionally datasets if
`BQAA_AUTO_CREATE_DATASET=true`.

Automatic bootstrap, safe dry-run first:

```bash
python -m pip install google-cloud-bigquery

python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION" \
  --service-account bqaa-writer
```

If the printed plan is correct, apply it:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION" \
  --service-account bqaa-writer \
  --execute
```

The bootstrap command enables the required BigQuery APIs, creates the dataset
and `agent_events` table if missing, and grants the runtime principal the
narrow BigQuery roles below. `--service-account bqaa-writer` creates
`bqaa-writer@${BQAA_PROJECT_ID}.iam.gserviceaccount.com` if it does not exist.
Use `--principal "user:name@example.com"` instead when the agent runtime uses
user ADC. Add `--runtime-auto-create-dataset` only when the runtime itself will
run with `BQAA_AUTO_CREATE_DATASET=true`.

### Preflight + unattended (agent) runs

Every invocation prints a one-screen preflight summary so an agent can see
what credentials it would use:

```
Preflight:
  ADC: OK — ADC token reachable
  gcloud config project: my-gcp-project (matches --project)
```

With `--execute`, the script hard-fails before touching anything when:

- `gcloud` is not on `PATH` — `gcloud is required for --execute but is
  not available. Install the Google Cloud SDK and re-run.`
- Application Default Credentials are not configured —
  `Application Default Credentials are not configured. Run
  `gcloud auth application-default login` (or set
  `GOOGLE_APPLICATION_CREDENTIALS` to a service-account JSON key) and
  re-run.`

In dry-run, both conditions are reported but the plan is still printed
so an agent can pre-stage everything before the human runs the OAuth
flow.

For unattended runs (Codex, Claude SDK, CI), pass `--non-interactive`:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --service-account bqaa-writer \
  --non-interactive --execute
```

`--non-interactive` injects `--quiet` into every `gcloud` and `bq`
subcommand so a confirmation prompt can never block the bootstrap.
`gcloud config get-value project` mismatches with `--project` are
warnings, not errors — every subcommand passes `--project` explicitly,
so the explicit flag wins.

Required APIs:

```bash
gcloud services enable bigquery.googleapis.com bigquerystorage.googleapis.com iam.googleapis.com \
  --project "$BQAA_PROJECT_ID"
```

`iam.googleapis.com` is only needed when the bootstrap command creates a
service account; the BigQuery APIs are needed for the tracing writer paths.

Recommended IAM by deployment mode:

| Mode | Required roles |
| --- | --- |
| Existing dataset and table | `roles/bigquery.dataEditor` on the dataset |
| Auto-create table in an existing dataset | `roles/bigquery.dataEditor` on the dataset |
| Auto-create dataset and table in the bootstrap script | bootstrap identity needs create permissions; runtime principal needs `roles/bigquery.dataEditor` on the dataset after creation |
| Runtime auto-creates dataset/table | `roles/bigquery.user` on the project plus `roles/bigquery.dataEditor` after the dataset exists, or `roles/bigquery.admin` for bootstrap-only setup |
| Run verification SQL or smoke scripts that query the table | `roles/bigquery.jobUser` on the project plus dataset read/write access |

Manual IAM equivalent:

```bash
SERVICE_ACCOUNT="bqaa-writer@${BQAA_PROJECT_ID}.iam.gserviceaccount.com"

# Existing dataset/table, or auto-create table inside an existing dataset:
bq add-iam-policy-binding \
  -d \
  "${BQAA_PROJECT_ID}:${BQAA_DATASET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.dataEditor

# Needed for `bq query` verification and smoke scripts that query BigQuery:
gcloud projects add-iam-policy-binding "$BQAA_PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.jobUser

# Only if BQAA_AUTO_CREATE_DATASET=true in the runtime:
gcloud projects add-iam-policy-binding "$BQAA_PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.user
```

Keep `roles/bigquery.admin` out of steady-state agent runtimes. It is useful
for first-time bootstrap in a dev project, but the runtime writer only needs
the narrower roles above.

## 2. Install Runtime Dependencies

Minimum:

```bash
pip install google-cloud-bigquery
```

Recommended for async Storage Write API draining:

```bash
pip install google-cloud-bigquery-storage pyarrow
```

Optional channel dependencies:

```bash
pip install openai-agents       # only for OpenAI Agents SDK tracing
```

If the agent host should use a specific Python:

```bash
export BQAA_PYTHON="/path/to/python"
```

## 3. Configure Common Tracing Options

```bash
export BQAA_WRITER_LABEL="bqaa-coding-agent-plugin/0.1.0/team-name"
export BQAA_USER_ID="$USER"
export BQAA_AUTO_CREATE_TABLE="true"
export BQAA_AUTO_CREATE_DATASET="false"
```

Default write mode is local spool plus async drainer. Use direct writes only
for one-process smoke tests or debugging:

```bash
export BQAA_DIRECT_WRITE="true"
```

Dry-run mode writes JSON rows to the local log file instead of BigQuery:

```bash
export BQAA_DRY_RUN="true"
export BQAA_LOG_FILE="/tmp/bqaa-agent-tracing.log"
```

## 4. Claude Code

Distribution channel: repo-local Claude plugin marketplace.

Install:

```bash
claude plugin marketplace add ./
claude plugin install bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin
```

Restart Claude Code after installation. Hooks load at session start.

Verify:

1. Start a new Claude Code session.
2. Run a prompt that uses a tool.
3. Query BigQuery:

```sql
SELECT event_type, agent, JSON_VALUE(attributes, '$.writer.label') AS writer_label
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND JSON_VALUE(attributes, '$.custom_tags.assistant') = 'claude_code'
ORDER BY timestamp DESC
LIMIT 20;
```

## 5. Claude Agent SDK (Python)

Distribution channel: same Claude plugin in this repo, loaded into the
`claude` subprocess that the Agent SDK spawns. This means SDK-driven
agents emit the same Claude Code BQAA rows (writer.agent =
`claude-code` by default, override via `BQAA_AGENT_NAME`) without any
new code paths to maintain.

Install:

```bash
pip install claude-agent-sdk
```

Load the plugin from this repo via `ClaudeAgentOptions.plugins`:

```python
import asyncio
import os
from pathlib import Path

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

PLUGIN_DIR = Path("/path/to/plugins/bigquery-agent-analytics-tracing").resolve()


async def main() -> None:
    options = ClaudeAgentOptions(
        cwd="/your/project/path",
        env={
            **os.environ,
            "BQAA_PROJECT_ID": "your-gcp-project",
            "BQAA_DATASET": "agent_analytics",
            "BQAA_TABLE": "agent_events",
            "BQAA_LOCATION": "US",
            # Distinguish SDK-driven traffic from Claude Code TUI traffic:
            "BQAA_AGENT_NAME": "claude-agent-sdk",
            "BQAA_WRITER_LABEL": "bqaa-coding-agent-plugin/0.1.0/sdk-app-name",
        },
        permission_mode="bypassPermissions",
        plugins=[{"type": "local", "path": str(PLUGIN_DIR)}],
    )
    async with ClaudeSDKClient(options=options) as client:
        await client.query("Read README.md and summarize it in one sentence.")
        async for _message in client.receive_response():
            pass


asyncio.run(main())
```

Either of these load mechanisms works. Pick `plugins=` for a typed,
declarative API; pick `extra_args=` if you're forwarding arbitrary
flags to the underlying `claude` binary already:

```python
# Equivalent — passes --plugin-dir to the spawned claude binary.
options = ClaudeAgentOptions(
    cwd="/your/project/path",
    env={...},  # same env block as above
    extra_args={"plugin-dir": str(PLUGIN_DIR)},
)
```

The plugin loads when the SDK spawns its `claude` subprocess, so
hooks fire from the very first turn of the SDK session — no restart
semantics to worry about.

Verify:

```sql
SELECT event_type, agent, JSON_VALUE(attributes, '$.writer.agent') AS writer_agent,
       JSON_VALUE(attributes, '$.writer.label') AS writer_label
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND JSON_VALUE(attributes, '$.writer.agent') = 'claude-agent-sdk'
ORDER BY timestamp DESC
LIMIT 20;
```

Caveats:

- The SDK runs `claude` under the hood, so `claude` must be on `PATH`
  (or set via `ClaudeAgentOptions.cli_path`).
- `ClaudeAgentOptions.env` must include `BQAA_*` — the SDK does not
  inherit the parent process env unless you pass it through.
- For multi-turn SDK sessions, each turn produces its own
  `LLM_REQUEST` / `LLM_RESPONSE` row pair under the same Claude
  `session_id`, so trace continuity holds across turns.

## 6. Codex CLI

Distribution channel: wrapper command in this repo.

The wrapper supports `codex exec` only. Interactive `codex` TUI sessions are
not captured because Codex CLI does not currently expose a runtime hook surface
for those sessions. Codex plugin marketplace packages commands; it does not add
Claude-style runtime hooks.

Use:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/bqaa_codex.py \
  --sandbox read-only \
  "list the files"
```

Alias:

```bash
alias bqaa-codex="python /path/to/plugins/bigquery-agent-analytics-tracing/scripts/bqaa_codex.py"
bqaa-codex --sandbox read-only "summarize this repo"
```

Stdin works:

```bash
printf 'summarize README.md\n' | bqaa-codex -
```

When argv and stdin are both present, the BQAA `LLM_REQUEST` prompt records:

```text
<argv prompt>
<stdin>
<stdin payload>
</stdin>
```

The BQAA prompt capture is capped at 1 MiB, but the wrapper still forwards the
full stdin payload to Codex.

Verify wrapper edge cases:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/test_codex_wrapper.py
```

Verify live:

```sql
SELECT
  event_type,
  JSON_VALUE(content, '$.tool') AS tool,
  JSON_VALUE(attributes, '$.source') AS source,
  JSON_VALUE(attributes, '$.codex.version') AS codex_version,
  JSON_VALUE(attributes, '$.codex.raw_event_type') AS raw_event_type,
  JSON_VALUE(attributes, '$.writer.label') AS writer_label
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND JSON_VALUE(attributes, '$.source') = 'codex_cli'
ORDER BY timestamp DESC
LIMIT 20;
```

## 7. OpenAI Agents SDK

Distribution channel: Python module in this repo.

Add the SDK path:

```bash
export PYTHONPATH="/path/to/plugins/bigquery-agent-analytics-tracing/sdk/python:$PYTHONPATH"
```

Register the processor:

```python
from agents import Agent, Runner
from bqaa_openai_agents import add_bqaa_trace_processor

add_bqaa_trace_processor(agent_name="openai-agents")

agent = Agent(name="Assistant", instructions="Be concise.")
result = Runner.run_sync(agent, "Say hello")
```

`add_bqaa_trace_processor()` uses `agents.tracing.add_trace_processor()` so the
default OpenAI exporter remains installed. Use
`agents.tracing.set_trace_processors([processor])` only when you intentionally
want to replace the default processors.

Smoke test without a model call:

```bash
PYTHONPATH="/path/to/plugins/bigquery-agent-analytics-tracing/sdk/python:$PYTHONPATH" \
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_openai_agents_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION"
```

## 8. Other Python Agents

Distribution channel: direct Python SDK module in this repo.

```python
from bqaa_tracing import BigQueryAgentAnalyticsLogger

logger = BigQueryAgentAnalyticsLogger()
logger.log_llm_request(
    prompt="Inspect this repo",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="custom-agent",
)
logger.log_llm_response(
    response="Done",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="custom-agent",
    model="custom-model",
    usage_metadata={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    total_ms=1200,
)
```

## 9. Adoption Query

Use this query to see all supported producers in one table:

```sql
SELECT
  JSON_VALUE(attributes, '$.writer.agent') AS agent,
  JSON_VALUE(attributes, '$.source') AS source,
  JSON_VALUE(attributes, '$.writer.label') AS writer_label,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(DISTINCT user_id) AS users,
  COUNT(*) AS events
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND JSON_VALUE(attributes, '$.writer.plugin') = 'bqaa-coding-agent-plugin'
GROUP BY agent, source, writer_label
ORDER BY events DESC;
```

## 10. Troubleshooting

- No rows: check `BQAA_PROJECT_ID`, `BQAA_DATASET`, credentials, and
  `BQAA_DRY_RUN`.
- Rows stuck in spool: check `BQAA_SPOOL_DIR/dead-letter/` and
  `BQAA_LOG_FILE`.
- Claude Code rows missing: restart Claude Code after installing the
  plugin.
- Claude Agent SDK rows missing: confirm `BQAA_*` env vars are passed
  via `ClaudeAgentOptions.env` (the SDK does not inherit parent env)
  and that `plugins=[{"type":"local","path":...}]` (or
  `extra_args={"plugin-dir":...}`) points at this repo's plugin
  directory.
- Codex TUI missing: use the `bqaa_codex.py` wrapper with
  `codex exec`; the TUI is outside this integration.
- OpenAI Agents rows missing: confirm `openai-agents` is installed
  and `add_bqaa_trace_processor()` runs before `Runner.run*()`.
