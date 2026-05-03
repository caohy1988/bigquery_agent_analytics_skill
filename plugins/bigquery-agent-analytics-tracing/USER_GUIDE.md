# BigQuery Agent Analytics Tracing User Guide

This guide covers how users get the tracing plugin, configure BigQuery, and
start emitting rows for each supported producer.

## Supported Channels

| Channel | Distribution | Runtime integration |
| --- | --- | --- |
| Claude Code | Claude plugin marketplace in this repo | Native Claude hook plugin |
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

## 5. Codex CLI

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

## 6. OpenAI Agents SDK

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

## 7. Other Python Agents

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

## 8. Adoption Query

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

## 9. Troubleshooting

- No rows: check `BQAA_PROJECT_ID`, `BQAA_DATASET`, credentials, and
  `BQAA_DRY_RUN`.
- Rows stuck in spool: check `BQAA_SPOOL_DIR/dead-letter/` and
  `BQAA_LOG_FILE`.
- Claude rows missing: restart Claude Code after installing the plugin.
- Codex TUI missing: use the `bqaa_codex.py` wrapper with `codex exec`; the TUI
  is outside this integration.
- OpenAI Agents rows missing: confirm `openai-agents` is installed and
  `add_bqaa_trace_processor()` runs before `Runner.run*()`.
