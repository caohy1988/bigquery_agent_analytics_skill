# BigQuery Agent Analytics Tracing Plugin

Logs Claude Code (and other coding-agent) hook traces into a Google ADK
BigQuery Agent Analytics `agent_events` table.

This is the operational counterpart to the
[`bigquery-agent-analytics-skill`](../../bigquery-agent-analytics-skill) in
this repo: the skill teaches Claude how to query BQAA data; this plugin is
what produces that data from your local Claude Code sessions.

For installation and first-use instructions across all supported channels, see
[USER_GUIDE.md](USER_GUIDE.md). This README focuses on implementation details
and per-channel reference snippets.

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
export BQAA_WRITER_LABEL="bqaa-coding-agent-plugin/0.1.0"   # see "Writer attribution" below
```

### Authentication

The plugin uses the standard Google Cloud auth chain. Either of these works:

- **Application Default Credentials** (recommended for local dev):
  `gcloud auth application-default login`. No env var needed.
- **Service account JSON**:
  `export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"`.

The service account or user identity needs:

- `roles/bigquery.dataEditor` on the dataset for inserts and table
  create-on-first-use inside an existing dataset.
- `roles/bigquery.jobUser` on the project for verification queries and smoke
  scripts that run `SELECT` statements.
- `roles/bigquery.user` on the project only if
  `BQAA_AUTO_CREATE_DATASET=true`.

Enable `bigquery.googleapis.com` for all write paths. Enable
`bigquerystorage.googleapis.com` for the recommended async Storage Write API
drainer path. Enable `iam.googleapis.com` only when the bootstrap command
creates a service account.

To let Codex or Claude set this up from one deterministic command, run the
bootstrap script in dry-run mode first:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION" \
  --service-account bqaa-writer
```

Then append `--execute` to apply the plan. The script can create the
`bqaa-writer` service account, create the BigQuery dataset/table, enable APIs,
and grant runtime IAM. See
[USER_GUIDE.md](./USER_GUIDE.md#1-prepare-bigquery) for the full IAM matrix,
manual commands, and runtime auto-create options.

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

## Codex CLI (codex exec only)

Codex CLI doesn't ship a hook system, but `codex exec --json` emits a
JSONL event stream. The `bqaa-codex` wrapper at
`scripts/bqaa_codex.py` runs `codex exec --json` as a subprocess,
maps each event to a BQAA row via the same spool/drainer pipeline as
the Claude Code hook adapter, and forwards Codex's agent text to your
stdout — so the wrapper is a drop-in for `codex exec`.

> **Scope:** this wrapper instruments `codex exec` (the non-interactive
> entrypoint). Interactive `codex` TUI sessions are **not** captured —
> there is no equivalent JSONL or hook surface in the TUI today. If
> Codex grows a runtime tracing callback, swap the wrapper for that.
> Codex plugins (`codex plugin marketplace`) package commands, not
> hooks, so they aren't a fit either.

```bash
# Where you used to run:
codex exec --skip-git-repo-check --sandbox read-only "list the files"

# Run instead:
python plugins/bigquery-agent-analytics-tracing/scripts/bqaa_codex.py \
  --skip-git-repo-check --sandbox read-only "list the files"

# Or alias it:
alias bqaa-codex="python /path/to/scripts/bqaa_codex.py"
bqaa-codex --skip-git-repo-check --sandbox read-only "list the files"
```

Event mapping:

| Codex event | BQAA event |
| --- | --- |
| `thread.started` | captured as `session_id` |
| `turn.started` | `LLM_REQUEST` (with the wrapper-captured prompt) |
| `item.started` (non-message) | `TOOL_STARTING` |
| `item.completed` (non-message) | `TOOL_COMPLETED` |
| `item.completed` (`agent_message`) | accumulated, echoed to stdout |
| `turn.completed` | `LLM_RESPONSE` (with `usage`) |

Rows are tagged `attributes.source = "codex_cli"` and
`attributes.writer.agent = "codex-cli"` (override `BQAA_AGENT_NAME`
to change). All other BQAA env vars work unchanged.

For schema-drift debugging, every row also carries an
`attributes.codex` block:

- `codex.version` — `codex --version` captured at wrapper init.
- `codex.raw_event_type` — the source event type (`turn.started`,
  `turn.completed`, `item.started`, `item.completed`).
- `codex.raw_item_type` — the underlying Codex item type for tool
  rows (`command_execution`, `agent_message`, `mcp_tool_call`, etc.).

### Prompt capture

The wrapper combines argv and stdin so `attributes.content.prompt`
matches what Codex actually sees:

- The trailing positional in argv is the argv prompt. The parser
  knows Codex's value-flags (`-c`, `-m`, `-s`, `-o`,
  `--output-last-message`, `--output-schema`, etc.) so it doesn't
  mistake a flag value for the prompt.
- If stdin is piped (non-TTY), the wrapper captures the first 1 MiB
  for the BQAA row but still passes the full stdin payload to Codex.
  When both argv and stdin are present, the wrapper records the
  prompt as `<argv>\n<stdin>...stdin payload...</stdin>` to mirror
  Codex's own `<stdin>` block convention.
- `BQAA_CODEX_PROMPT` is a final fallback when neither argv nor
  stdin yields a prompt.

### Other env vars

`BQAA_CODEX_BIN` lets you point at a non-`PATH` Codex install (the
wrapper invokes `codex --version` and `codex exec --json` against
this binary).

## Other Agents (direct SDK)

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

## OpenAI Agents SDK

The OpenAI Agents SDK supports custom trace exporters through
`TracingProcessor`. Register this plugin with `add_trace_processor()` when you
want to keep OpenAI's default exporter and also write BQAA rows:

```bash
pip install openai-agents google-cloud-bigquery
```

```python
from agents import Agent, Runner
from bqaa_openai_agents import add_bqaa_trace_processor

add_bqaa_trace_processor(agent_name="openai-agents")

agent = Agent(name="Assistant", instructions="Be concise.")
result = Runner.run_sync(agent, "Say hello")
```

`generation` spans become paired `LLM_REQUEST` / `LLM_RESPONSE` rows, and
`function` spans become paired `TOOL_STARTING` / `TOOL_COMPLETED` rows. Use
`agents.tracing.set_trace_processors([processor])` only when you intentionally
want to replace the SDK's default processors.

To smoke-test the processor without making a model call:

```bash
PYTHONPATH="plugins/bigquery-agent-analytics-tracing/sdk/python:$PYTHONPATH" \
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_openai_agents_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset agent_analytics \
  --table agent_events \
  --location US
```

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

## Writer attribution & adoption tracking

Every write carries a writer label so a dataset operator can attribute traces
back to this plugin without inspecting the agent's environment. ADK does the
same thing with `google-adk-bq-logger/<version>`; this plugin uses
`bqaa-coding-agent-plugin/<version>` by default.

The label appears in two places:

1. **`attributes.writer` on every row.** Visible from the events table
   itself, on both the Storage Write and the `insert_rows_json` paths.
   This is the primary surface for self-service adoption queries.
   Fields: `plugin`, `version`, `label`, `agent`, `mode`
   (`spool` / `direct` / `dry_run`).
2. **`AppendRowsRequest.trace_id`** when writing via the Storage Write API.
   This is request-level metadata recorded server-side by Google for
   diagnostics; it isn't surfaced as a column in the
   `INFORMATION_SCHEMA.WRITE_API_TIMELINE_BY_*` views, but it lets
   Google Cloud support attribute traffic back to this plugin when
   investigating throughput / quota issues.

Override the label per deployment with `BQAA_WRITER_LABEL` (e.g.
`bqaa-coding-agent-plugin/0.1.0/team-foo`) so multiple teams sharing one
dataset stay distinguishable. The override flows through to both surfaces.

### Adoption / usage queries

**Plugin adoption broken down by agent + mode + version** (works for any
write path):

```sql
SELECT
  JSON_VALUE(attributes, '$.writer.label')   AS writer_label,
  JSON_VALUE(attributes, '$.writer.plugin')  AS plugin,
  JSON_VALUE(attributes, '$.writer.version') AS plugin_version,
  JSON_VALUE(attributes, '$.writer.agent')   AS agent,
  JSON_VALUE(attributes, '$.writer.mode')    AS mode,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(DISTINCT user_id)    AS users,
  COUNT(*)                   AS events
FROM `your-project.your_dataset.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY writer_label, plugin, plugin_version, agent, mode
ORDER BY events DESC
```

**Storage Write API volume on this dataset** (no writer breakdown — the
Storage Write API timeline view doesn't expose the trace_id column —
useful for sanity-checking that writes are flowing and for capacity
planning):

```sql
SELECT
  table_id,
  stream_type,
  error_code,
  SUM(total_rows) AS rows_written,
  SUM(total_requests) AS requests,
  SUM(total_input_bytes) AS input_bytes
FROM `region-us`.INFORMATION_SCHEMA.WRITE_API_TIMELINE_BY_PROJECT
WHERE start_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND project_id = 'your-project'
  AND dataset_id = 'your_dataset'
GROUP BY table_id, stream_type, error_code
ORDER BY rows_written DESC
```

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
