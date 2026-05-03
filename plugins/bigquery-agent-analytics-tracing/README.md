# BigQuery Agent Analytics Tracing Plugin

Logs Claude Code (and other coding-agent) hook traces into a Google ADK
BigQuery Agent Analytics `agent_events` table.

This is the operational counterpart to the
[`bigquery-agent-analytics-skill`](../../bigquery-agent-analytics-skill) in
this repo: the skill teaches Claude how to query BQAA data; this plugin is
what produces that data from your local Claude Code sessions.

## How it works

```
Claude Code hook (bash)  ->  bqaa_hook.py  ->  spool/event-*.json   (sync, ~1 ms)
                                             |
                                             +-> spawn detached drainer
                                                       |
                                                       v
                              bqaa_drain.py  ->  BigQuery Storage Write API
                                                  (async, batched, retried,
                                                   dead-lettered on failure)
```

The hot path that runs inside the agent process never blocks on BigQuery.
The drainer is a single-instance background process (enforced by
`fcntl.flock`) that batches spooled rows and writes them via the
`BigQueryWriteAsyncClient` Storage Write API. If the Storage Write client
or PyArrow are not importable, it falls back to legacy
`insert_rows_json` automatically.

## Configuration

Required:

```bash
export BQAA_PROJECT_ID="your-project-id"      # also reads GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT
export BQAA_DATASET="your_dataset"            # also reads BQ_DATASET
```

Common optional:

```bash
export BQAA_TABLE="agent_events"
export BQAA_LOCATION="US"
export BQAA_AGENT_NAME="claude-code"
export BQAA_USER_ID="$USER"
export BQAA_DRY_RUN="false"                   # if true, writes to BQAA_LOG_FILE only
export BQAA_DIRECT_WRITE="false"              # if true, hook writes inline (legacy)
export BQAA_AUTO_CREATE_TABLE="true"
export BQAA_AUTO_CREATE_DATASET="false"
```

Spool / drainer tuning:

```bash
export BQAA_SPOOL_DIR="/tmp/bqaa-agent-tracing/spool"
export BQAA_STATE_DIR="/tmp/bqaa-agent-tracing"
export BQAA_DRAIN_BATCH_SIZE="50"
export BQAA_DRAIN_IDLE_SECONDS="8"
export BQAA_DRAIN_POLL_SECONDS="0.5"
export BQAA_TRANSCRIPT_MAX_BYTES="262144"     # 256 KB cap for SubagentStop transcripts
export BQAA_STATE_TTL_HOURS="24"              # purge orphaned state files older than this
```

### Authentication

The plugin uses the standard Google Cloud auth chain. Either of these works:

- **Application Default Credentials** (recommended for local dev):
  `gcloud auth application-default login`. No env var needed.
- **Service account JSON**:
  `export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"`.

The service account or user identity needs:

- `bigquery.dataEditor` on the dataset (for inserts and table create-on-first-use).
- `bigquery.jobUser` on the project (for table existence checks during fallback).

### Python runtime

```bash
pip install google-cloud-bigquery
# Recommended for the async Storage Write API path used by the drainer:
pip install google-cloud-bigquery-storage pyarrow
```

If Claude Code should use a specific interpreter:

```bash
export BQAA_PYTHON="/path/to/python"
```

The drainer is spawned with `BQAA_PYTHON` (or `sys.executable`) and
inherits the hook's environment, so it sees the same auth + config.

## Claude Code

From this repository:

```bash
claude plugin marketplace add ./
claude plugin install bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin
```

Hooks load at session start, so restart Claude Code after install.

For the Claude Agent SDK:

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

Codex packaging is in `.codex-plugin/plugin.json`, with an example
marketplace entry in `codex-marketplace.example.json`.

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
    usage_metadata={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    total_ms=1200,
)
```

When called from a long-lived Codex process, you may prefer the inline
write path: `export BQAA_DIRECT_WRITE=true`. Otherwise the same spool +
drainer pipeline is used.

Add `plugins/bigquery-agent-analytics-tracing/sdk/python` to `PYTHONPATH`,
or vendor the two SDK modules (`bqaa_tracing.py`, `bqaa_drain.py`) into
your agent runtime.

## Table Shape

Rows are written to `{project}.{dataset}.{table}` with the same columns
used by ADK BQAA:

`timestamp`, `event_type`, `agent`, `session_id`, `invocation_id`,
`user_id`, `trace_id`, `span_id`, `parent_span_id`, `content`,
`content_parts`, `attributes`, `latency_ms`, `status`, `error_message`,
`is_truncated`.

The table is auto-created on first write (day-partitioned on `timestamp`,
clustered on `event_type, agent, user_id`). Dataset auto-creation is off
by default; set `BQAA_AUTO_CREATE_DATASET=true` only when the identity
is allowed to create datasets.

## Reliability

- **No agent latency from BigQuery.** The hook only writes to a local
  JSONL file then exits. Even if BigQuery is degraded, your agent sees
  the same per-tool overhead (~5–20 ms for spool + Popen, plus Python
  startup).
- **Single-writer drainer.** Multiple hook fires can't double-write
  because the drainer is gated by `fcntl.flock` on a pidfile. The
  drainer exits after `BQAA_DRAIN_IDLE_SECONDS` of empty polling; the
  next event respawns it.
- **Retries.** Transient `ServiceUnavailable`, `TooManyRequests`,
  `InternalServerError`, and timeout errors are retried with
  exponential backoff (matches ADK's `RetryConfig` defaults: 3 retries,
  1 s initial, 2× multiplier, 10 s cap).
- **Dead-letter.** Permanently-failed rows move to
  `BQAA_SPOOL_DIR/dead-letter/` for manual inspection and replay.
- **Race-free state.** The per-session state file is read-modify-written
  under `fcntl.flock`. Per-tool span IDs and start times live in their
  own files keyed by `tool_use_id`, so concurrent `PreToolUse` fires
  can't clobber each other.
- **Bounded transcript reads.** `Stop` and `SubagentStop` stream the
  transcript with a `BQAA_TRANSCRIPT_MAX_BYTES` cap so multi-MB
  subagent transcripts don't blow up memory.

## Dry Run

```bash
export BQAA_DRY_RUN=true
```

In dry-run, rows are appended as JSONL to `BQAA_LOG_FILE`
(`/tmp/bqaa-agent-tracing.log` by default) instead of being spooled or
inserted. The drainer is not spawned.

## End-to-End BigQuery Smoke Test

Inserts one trace with four events and queries it back:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_bigquery_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset agent_analytics \
  --table agent_events \
  --location US
```

Expected `event_types`: `LLM_REQUEST`, `TOOL_STARTING`, `TOOL_COMPLETED`,
`LLM_RESPONSE`.

The smoke script uses `BQAA_DIRECT_WRITE` semantics (synchronous insert)
so it can verify the data round-trip in a single process. Soft dep: the
`bq` CLI is convenient but not required — the script queries BigQuery
through the Python client.
