# BigQuery Agent Analytics Tracing Plugin

Logs coding-agent traces into a Google ADK BigQuery Agent Analytics table.

This mirrors the Arize Claude Code plugin shape:

- `.claude-plugin/plugin.json` registers Claude Code hooks.
- `hooks/*.sh` forward hook payloads to a shared Python adapter.
- `sdk/python/bqaa_tracing.py` writes rows in the BQAA `agent_events` schema.
- `.codex-plugin/plugin.json` packages the same SDK for Codex/local plugin use.

## Configuration

```bash
export GCP_PROJECT_ID="your-project-id"
export BQAA_DATASET="your_dataset"
export BQAA_TABLE="agent_events"
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"

# Optional
export BQAA_AGENT_NAME="claude-code"
export BQAA_USER_ID="$USER"
export BQAA_LOCATION="US"
export BQAA_DRY_RUN="false"
export BQAA_AUTO_CREATE_TABLE="true"
export BQAA_AUTO_CREATE_DATASET="false"
export BQAA_STATE_DIR="/tmp/bqaa-agent-tracing"
```

Install the runtime dependency in the Python environment used by hooks:

```bash
pip install google-cloud-bigquery
```

If Claude Code should use a specific interpreter:

```bash
export BQAA_PYTHON="/path/to/python"
```

## Claude Code

From this repository:

```bash
claude plugin marketplace add .
claude plugin install bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin
```

For the Claude Agent SDK, point to this plugin directory:

```python
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

options = ClaudeAgentOptions(
    plugins=[{"type": "local", "path": "./plugins/bigquery-agent-analytics-tracing"}],
    settings="./settings.local.json",
)
```

The plugin records these BQAA events:

| Claude hook | BQAA event |
| --- | --- |
| `UserPromptSubmit` | `LLM_REQUEST` |
| `Stop` | `LLM_RESPONSE` |
| `PreToolUse` | `TOOL_STARTING` |
| `PostToolUse` | `TOOL_COMPLETED` |
| `PermissionRequest` | `HITL_CONFIRMATION_REQUEST` |
| `Notification`, `SessionEnd` | `STATE_DELTA` |
| `SubagentStop` | child-agent `LLM_RESPONSE` |

## Codex / Other Agents

Codex packaging is provided in `.codex-plugin/plugin.json`, and an example
marketplace entry is in `codex-marketplace.example.json`.

Codex runtimes without Claude-style hooks should call the SDK directly:

```python
from bqaa_tracing import BigQueryAgentAnalyticsLogger

logger = BigQueryAgentAnalyticsLogger()
logger.log_llm_request(
    prompt="Inspect this repo",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="codex",
)
logger.log_llm_response(
    response="Done",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="codex",
    model="gpt-5",
    usage_metadata={
        "prompt_tokens": 10,
        "completion_tokens": 5,
        "total_tokens": 15,
    },
    total_ms=1200,
)
```

Add `plugins/bigquery-agent-analytics-tracing/sdk/python` to `PYTHONPATH`, or
vendor that single module into your agent runtime.

## Table Shape

Rows are written to `{project}.{dataset}.{table}` with the same columns used by
ADK BQAA:

`timestamp`, `event_type`, `agent`, `session_id`, `invocation_id`, `user_id`,
`trace_id`, `span_id`, `parent_span_id`, `content`, `content_parts`,
`attributes`, `latency_ms`, `status`, `error_message`, `is_truncated`.

The table is created automatically by default when it does not exist. Dataset
creation is disabled by default; set `BQAA_AUTO_CREATE_DATASET=true` only when
the service account is allowed to create datasets.

## Dry Run

```bash
export BQAA_DRY_RUN=true
```

Dry-run rows are appended to `BQAA_LOG_FILE` (`/tmp/bqaa-agent-tracing.log` by
default) instead of being inserted into BigQuery.

## End-to-End BigQuery Smoke Test

This inserts one trace with four events and queries it back:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_bigquery_smoke.py \
  --project "$GCP_PROJECT_ID" \
  --dataset agent_analytics \
  --table agent_events \
  --location US
```

Expected `event_types`:

- `LLM_REQUEST`
- `TOOL_STARTING`
- `TOOL_COMPLETED`
- `LLM_RESPONSE`
