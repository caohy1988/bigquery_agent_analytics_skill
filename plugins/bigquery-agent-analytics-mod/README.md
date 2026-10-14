# BigQuery Agent Analytics: a coding-agent mod

A coding-agent **mod** (a plugin whose code is a JavaScript/TypeScript hooks
module that runs inside the host coding-agent CLI; see the
[mod docs](https://code.claude.com/docs/en/plugins/mods/overview)) that
records each session's turns,
model requests, tool calls and subagents as rows in the
[BigQuery Agent Analytics](https://adk.dev/integrations/bigquery-agent-analytics/)
(BQAA) `agent_events` schema, and streams them to BigQuery from the
background.

It produces the same table shape as ADK's BQAA plugin and this repo's
settings-hook plugin, [`bigquery-agent-analytics-tracing`](../bigquery-agent-analytics-tracing),
so the [analysis skill](../../bigquery-agent-analytics-skill) and its queries
work on what it writes.

Status: early. Mods are an early-access feature of the host CLI (v2.1.287 or
later); this mod was built and tested against **v2.1.296**. Its
writer was tested against a scripted BigQuery API (no live BigQuery insert has
been made from this change; see [Testing](#testing)).

## Why a mod, and not settings hooks

The tracing plugin runs a shell script for each settings-hook event. Those
hooks are foreground processes: the host CLI waits for each one, and PR #6 on
this repo ("Make tracing hooks non-blocking and fail-open", open as of this
writing) reworks them because they could hang the CLI. A mod runs inside the
host CLI, which lets this one keep a hard rule:

* Each capture hook (prompt, turn, model request, tool and subagent events)
  calls `next(e)` straight away, records what it saw into an in-memory queue
  (synchronous, bounded work), and returns what `next` gave it, unchanged.
* No hook waits on the network or a process; a background writer driven by
  `$.clock` timers does that. Two lifecycle hooks do bounded work of their own
  before passing their event on: `session.start` sets the writer up and
  registers the three commands, and `session.end` writes what is still queued
  to a spill file, waiting at most `BQAA_EXIT_FLUSH_MS` (800 ms) inside the
  host's end-of-session bound. That write is the only wait on the disk.
* If the mod's own code throws, the event goes on as if the mod were not
  installed (fail open). The five observers the validator lists as gating
  hooks (`classic.SessionStart`, `classic.SubagentStart`,
  `classic.PermissionRequest`, `prompt.submit`, `tool.call`) carry a
  `.catch(($, e, next) => next(e))`; the other hooks run their bookkeeping
  inside `try` blocks, so it cannot throw into the event.

The test suite holds the mod to that: a test makes BigQuery hang forever and
then runs 25 tool calls through the mod, and a test checks that no hook,
`session.end` included, calls `$.http.fetch` or `$.process.run`. Breaking the
rule on purpose (awaiting the flush inside the `tool.call` hook, or a network
flush in `session.end`) makes those tests fail; the hang test times out, which
is what a person would have seen as the CLI hanging.

## How it works

```
 host CLI (engine)                             bigquery-agent-analytics-mod
 ───────────────────                          ───────────────────────────────────────────────
 classic.SessionStart ─┐
 prompt.submit ────────┤   hook: next(e) first,       Tracer: event -> BQAA row
 turn.start ───────────┤   then record (sync)  ─────▶ (ids, spans, redaction,
 turn.step (stream) ───┤                              truncation, is_truncated)
 tool.call ────────────┤                                     │ enqueue (sync)
 classic.SubagentStart ┤                                     ▼
 turn.complete ────────┤                          ┌──────────────────────────────┐
 session.end ──────────┘                          │ bounded queue (rows + bytes, │
                                                  │ drops oldest when full)      │
                                                  └──────────────┬───────────────┘
 $.clock.every(flushIntervalMs) ─────────────────▶ Writer (background, one at a time)
                                                         │ token: $.process.run(gcloud …), cached
                                                         │ batch <= 500 rows / 3 MiB (UTF-8)
                                                         ▼
                                       $.http.fetch POST …/tables/{t}/insertAll
                                       (insertId = event_id, client timeout,
                                        30 s host cap)
                                          │ 2xx, valid     │ 408/429/5xx/network/timeout,
                                          │ insertAll      │ or a 2xx answer that does not
                                          │ answer         │ parse as an insertAll response
                                          ▼                ▼
                                       sent          retry with backoff (1 s … 60 s),
                                                     3 retries, then dead-letter
                                                          │ 401: refresh token, retry
                                                          │ 404 table: create it, retry
                                                          │ 400/403/invalid row: refused
                                                          ▼
                     $.fs.write  <deadLetterDir>/<project.dataset.table>/{spill,retry,rejected}-*.jsonl
                                                          │
       /bqaa-backfill, next session start, or recovery ──▶ insertAll again, to that table only
```

At `session.end` (the process is exiting) the mod starts no request: the
rows still queued, and any whose request has not answered yet, go to a spill
file in the table's dead-letter subdirectory, and the hook waits at most
`BQAA_EXIT_FLUSH_MS` for that write. The next session sends the file 15
seconds after it starts (or `/bqaa-backfill` does). A row whose request was
still in flight can arrive twice; `event_id` dedups it. `/clear` and
`/resume` keep sending as usual.

## Install

You need the host CLI at v2.1.287 or later (its `--version` flag prints it),
a BigQuery dataset, and a way to get a Google access token (below). The mod
creates the table on first write if it is missing.

**For one session, from a checkout** (development, or to try it):

```bash
export BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics
claude --plugin-dir ./plugins/bigquery-agent-analytics-mod
```

**From this repository's marketplace.** The mod is on the `coding-agent-mod`
branch until its PR merges; from a clone of that branch:

```bash
claude plugin marketplace add ./
claude plugin install bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin \
  --config project=my-gcp-project --config dataset=agent_analytics
```

Once merged, from GitHub (`--marketplace` needs v2.1.292 or later):

```bash
claude plugin install bigquery-agent-analytics-mod \
  --marketplace haiyuan-eng-google/bigquery_agent_analytics_skill \
  --config project=my-gcp-project --config dataset=agent_analytics
```

Inside a session, `/plugin install bigquery-agent-analytics-mod@bigquery-agent-analytics-plugin`
does the same and opens the configuration dialog. If you install or update it
from your shell while a session is open, run `/reload-plugins` there. Run
`/plugin` and look for `1 mod active · bigquery-agent-analytics-mod` under the tabs.

Use this mod **or** the settings-hook tracing plugin against a table, not both:
with both enabled every event is written twice.

## Configure

Options are the plugin's `userConfig` (the install dialog, `/plugin configure`,
`--config key=value`, or `/config`). A string option left empty falls back to
the environment variable the tracing plugin already uses, then to a default.

| Option | Environment fallback | Default | What it does |
| --- | --- | --- | --- |
| `project` | `BQAA_PROJECT_ID`, `GCP_PROJECT_ID`, `GOOGLE_CLOUD_PROJECT` | (required) | Project that holds the dataset |
| `dataset` | `BQAA_DATASET`, `BQ_DATASET` | (required) | Dataset of the events table |
| `table` | `BQAA_TABLE`, `BQ_TABLE` | `agent_events` | Events table |
| `location` | `BQAA_LOCATION` | `US` | Dataset location; shown by `/bqaa-status` (insertAll itself is addressed by table) |
| `enabled` | `BQAA_TRACE_ENABLED=false` turns it off | `true` | Capture on or off |
| `dryRun` | `BQAA_DRY_RUN=true` turns it on | `false` | Write rows as JSONL to `<deadLetterDir>/../dry-run/` instead of sending |
| `maxPayloadChars` | | `16384` (1024 to 500000) | Cap per JSON payload column (`content`, `attributes`); past it the value is cut and `is_truncated` set |
| `flushIntervalMs` | | `5000` (1000 to 300000) | How often the background writer sends |
| `deadLetterDir` | `BQAA_DEAD_LETTER_DIR` | `~/.bqaa-mod/dead-letter` | Where unsent rows are kept, in one subdirectory per table (`project.dataset.table`) |
| `agentName` | `BQAA_AGENT_NAME` | `coding-agent` | `agent` column for main-loop rows |
| `accessTokenCommand` | `BQAA_ACCESS_TOKEN_COMMAND` | `gcloud auth application-default print-access-token` | Command (argv, no shell) that prints an access token |

Advanced, environment only:

| Variable | Default | What it does |
| --- | --- | --- |
| `BQAA_ACCESS_TOKEN` | unset | Use this token as is (re-read every 5 minutes) instead of running the command |
| `BQAA_USER_ID` | `$USER` / `$USERNAME` | `user_id` column |
| `BQAA_REQUEST_TIMEOUT_MS` | `10000` (1000 to 30000) | Client-side timeout per insertAll request |
| `BQAA_MAX_QUEUE_ROWS` | `5000` (10 to 100000) | Queue bound in rows (the byte bound is 8 MiB of UTF-8) |
| `BQAA_EXIT_FLUSH_MS` | `800` (0 to 1200) | How long session end may wait for its spill file to be written; `0` starts the write without waiting |
| `BQAA_AUTO_CREATE_TABLE` | `true` | Create the table (BQAA schema v2, partitioned and clustered) when insertAll answers 404 for it |
| `BQAA_AUTO_BACKFILL` | `true` | Replay the table's `spill` and `retry` files at session start and after BigQuery recovers |

For a `--plugin-dir` session, options live in the host's user settings file under
`pluginConfigs["bigquery-agent-analytics-mod@inline"].options`, or use the
environment variables above.

### Authentication

`$.http.fetch` is plain HTTPS, so the mod needs an OAuth access token and
cannot use a Google client library. The background writer, never a hook, gets
one by running `accessTokenCommand` with `$.process.run` (default
`gcloud auth application-default print-access-token`, so Application Default
Credentials: run `gcloud auth application-default login` once, or set up
service-account impersonation for it). The token is kept in memory only,
reused for 45 minutes, refreshed on a 401, and sent only to
`bigquery.googleapis.com` (`$.http.fetch` drops the `Authorization` header on
a cross-origin redirect). `BQAA_ACCESS_TOKEN` skips the command. A
service-account key file cannot be used directly: the mods environment has
`crypto.subtle.digest` but no signing, so wrap it in a command that prints a
token. The type declarations mark `$.process.run` as CLI only; where it is
not available, set `BQAA_ACCESS_TOKEN`.

The identity needs `roles/bigquery.dataEditor` on the dataset (insert rows,
create the table). The repo's `setup_gcp_prereqs.py` grants it.

## What it writes

### Event mapping

| Host event (mod hook) | BQAA `event_type` | `content` | Notable `attributes` / `latency_ms` |
| --- | --- | --- | --- |
| `classic.SessionStart` | `STATE_DELTA` | `{"session_start": true}` | `state_delta.start_source` (`startup`, `resume`, `clear`, `compact`, `fork`), `model`, `session_metadata` (project, cwd, `host_version`) |
| `prompt.submit` (after it entered) | `USER_MESSAGE_RECEIVED` | `{"text_summary": prompt}` | `prompt_origin`, `submitted_during_turn` |
| `turn.start` | `INVOCATION_STARTING` | `{}` | `turn_number`, `session_metadata` |
| `turn.step`, before the request | `LLM_REQUEST` | `{"prompt": [{"role": "user", "content": …}]}` on a turn's first request, `{"prompt": []}` after | `model`, `llm_config.effort`, `step_index`, `message_count` |
| `turn.step`, response | `LLM_RESPONSE` | `{"tool_uses": [names], "response": text}` | `model`, `usage_metadata`, `finish_reason`; `latency_ms.total_ms`, `time_to_first_token_ms` |
| `turn.step`, no response | `LLM_ERROR` (status `ERROR`) | `null` | `latency_ms.total_ms` |
| `tool.call`, before | `TOOL_STARTING` | `{"tool", "tool_origin", "args"}` | `tool_use_id` |
| `tool.call`, after | `TOOL_COMPLETED` | `{"tool", "tool_origin", "result"}` | `latency_ms.total_ms`; status `ERROR` with `error_message` for a tool error or a hook's deny (`denied: true`); `permission_requested` |
| `classic.SubagentStart` | `AGENT_STARTING` | `{"agent_type", "agent_id"}` | `agent` column = subagent type |
| `turn.complete` (subagent) | `AGENT_COMPLETED` / `AGENT_ERROR` | `{}` | `usage_metadata` (the subagent's totals), `latency_ms.total_ms` |
| `turn.complete` (main loop) | `AGENT_RESPONSE` (if it answered) and `INVOCATION_COMPLETED` / `INVOCATION_ERROR` | `{"response": answer}` / `{}` | `finish_reason`, `is_aborted`, `step_count`, turn `usage_metadata`, `latency_ms.total_ms` |
| `classic.PermissionRequest` | (no row) | | sets `permission_requested` on the waiting tool's `TOOL_COMPLETED` |
| `session.end` | `STATE_DELTA` | `{"session_end": true}` | `state_delta.reason`, `trace_count`, `duration_ms` |

`usage_metadata` carries the names this repo's tracing plugin and analysis
skill read (`prompt_tokens` = input + cache read + cache write,
`completion_tokens`, `total_tokens`) and the four counts as the API reports
them (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`). Token counts come from the engine's
`turn.step` and `turn.complete` results.

A failed tool is `TOOL_COMPLETED` with status `ERROR`, as in the tracing
plugin and the analysis skill's failure-rate query (ADK itself uses
`TOOL_ERROR`). Every row has `attributes.writer`
(`{"plugin": "bigquery-agent-analytics-mod", "version", "label", "agent", "mode"}`),
`root_agent_name` and `source: "coding_agent"`.

### Ids and spans

* `session_id`: the host CLI's session id (it changes after `/clear`).
* `invocation_id`: the engine's turn id; a subagent's rows carry the turn that
  started it.
* `trace_id`: one 32-hex trace per main-loop turn; a subagent started in that
  turn shares it.
* `span_id` / `parent_span_id`: the turn's span is the root; each model
  request is a span under it (its `LLM_REQUEST` and `LLM_RESPONSE` share it);
  a tool call is a span under the model request that asked for it; a subagent
  has its own span under the turn, and its requests and tools nest under that.
* `event_id`: 32-hex, unique per row, sent as insertAll's `insertId`. It is
  the dedup key: a row sent again (an ambiguous timeout, a backfill) has the
  same one. Use `QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1`,
  as the ADK docs do.

### Table

[`sql/agent_events_ddl.sql`](sql/agent_events_ddl.sql) is the BQAA schema
version 2 (with `event_id`), day-partitioned on `timestamp` and clustered on
`event_type, agent, user_id`, the same as ADK's manual DDL. A table the
tracing plugin created (schema 1, no `event_id`) still takes the rows
(insertAll runs with `ignoreUnknownValues`); add the column with the `ALTER`
in that file to keep the dedup key.

The `JSON` columns (`content`, `attributes`, `latency_ms`) travel to insertAll
as JSON text. That is the representation Google's own Python client sends for
JSON-typed values on `tabledata.insertAll` (its `_json_to_json` converter is
`json.dumps`; [`_helpers.py`](https://github.com/googleapis/python-bigquery/blob/main/google/cloud/bigquery/_helpers.py)), and the one the tracing plugin's
`insert_rows_json` fallback uses.

### Sample rows

[`examples/sample-rows.jsonl`](examples/sample-rows.jsonl) is the insertAll
payload of a fixture session (`tests/sample-rows.test.ts`): a prompt, four
model requests, Read, Agent (an Explore subagent), Edit and Bash (with a
permission prompt), and session end. It holds the rows the stubbed insertAll
took, then the session-end row, which session end writes to a spill file for
the next session to send. **Sample output from the test
fixture:** the model id `example-model`, the token counts and the turn's
48,211 ms are fixture inputs; the model and tool `latency_ms` values are what
the run measured, a few milliseconds, since nothing really ran. Regenerate with:

```bash
claude plugin test . 2>&1 | sed -n 's/^BQAA_SAMPLE_ROW //p' > examples/sample-rows.jsonl
```

One `LLM_RESPONSE` row from it, JSON columns expanded:

```json
{
  "timestamp": "2026-10-14T02:54:21.137Z",
  "event_id": "d0529c41b9e2e1968859a1305b4a165f",
  "event_type": "LLM_RESPONSE",
  "agent": "coding-agent",
  "session_id": "5c4b1d2e-8f7a-4c3b-9d1e-2a6f0b7c8d9e",
  "invocation_id": "3f0e2a71-9c4d-4b8e-a1f6-52d7c0e9b134",
  "user_id": "dev",
  "trace_id": "a4db76890e3b711d381938f9c05e0935",
  "span_id": "014ed66196c9a931",
  "parent_span_id": "f5ceed92dfb61a76",
  "content": { "tool_uses": ["Read"], "response": "I'll look at the flush loop first." },
  "content_parts": [],
  "attributes": {
    "root_agent_name": "coding-agent",
    "source": "coding_agent",
    "model": "example-model",
    "model_version": "example-model",
    "usage_metadata": {
      "prompt_tokens": 20854, "completion_tokens": 96, "total_tokens": 20950,
      "input_tokens": 2310, "output_tokens": 96,
      "cache_read_input_tokens": 0, "cache_creation_input_tokens": 18544
    },
    "finish_reason": "tool_use",
    "step_index": 0,
    "writer": { "plugin": "bigquery-agent-analytics-mod", "version": "0.1.0", "label": "bigquery-agent-analytics-mod/0.1.0", "agent": "coding-agent", "mode": "insert_all" }
  },
  "latency_ms": { "total_ms": 1, "time_to_first_token_ms": 1 },
  "status": "OK",
  "error_message": null,
  "is_truncated": false
}
```

### Queries

[`sql/sample_queries.sql`](sql/sample_queries.sql) has eight, written with
the analysis skill's `{PROJECT}.{DATASET}.{TABLE}` placeholders and `@start` /
`@end` / `@trace_id` parameters so `scripts/run_bq.py` runs them: rows
deduplicated, tokens and cache share per session and model, model latency
(p50/p95 total, time to first token), tool failure rate and latency, one line
per turn, the span tree of a trace, subagents by type, and the mod's own
health. `QUALIFY` is evaluated after `GROUP BY`, so a query that aggregates
dedups on `event_id` in a CTE first and aggregates what it returns. For
example, tokens per model:

```sql
WITH responses AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  JSON_VALUE(attributes, '$.model') AS model,
  COUNT(*) AS model_requests,
  SUM(CAST(JSON_VALUE(attributes, '$.usage_metadata.input_tokens') AS INT64)) AS input_tokens,
  SUM(CAST(JSON_VALUE(attributes, '$.usage_metadata.cache_read_input_tokens') AS INT64)) AS cache_read_tokens,
  SUM(CAST(JSON_VALUE(attributes, '$.usage_metadata.output_tokens') AS INT64)) AS output_tokens
FROM responses
GROUP BY model
```

## Reliability

* **Queue:** in memory, bounded by `BQAA_MAX_QUEUE_ROWS` rows and 8 MiB of UTF-8; when
  full it drops its oldest rows and counts them. While BigQuery is failing and
  the queue passes 80%, the writer moves the oldest half to a `spill` file
  instead of letting rows drop.
* **Flush:** every `flushIntervalMs`, and right after each main-loop turn; one
  request at a time; batches of at most 500 rows and 3 MiB of UTF-8
  (`$.http.fetch` refuses bodies over 4 MiB, counted in characters, and UTF-8
  bytes are never fewer).
* **Timeouts:** each insertAll is raced against `BQAA_REQUEST_TIMEOUT_MS`
  (a `$.clock.after` timer), under the host's own 30-second cap per
  `$.http.fetch`; the token command has 15 seconds.
* **Retries:** 408, 429, 5xx, quota 403s, network errors and timeouts back off
  exponentially (1 s doubling to 60 s, with jitter) and retry a batch up to 3
  times with the same `insertId`s; a 401 refreshes the token first. A 2xx
  answer counts as delivered only when it is a valid insertAll response: a
  body cut off at the response limit, a non-JSON page or an `insertErrors`
  entry that names no row of the batch leaves the outcome unknown, so the rows
  are retried the same way and parked if the retries run out.
* **Dead letter:** rows that exhaust retries go to `retry-*.jsonl`; rows
  BigQuery or the configuration refuses (400, 403 access denied, missing
  dataset, an invalid row reported by insertAll) go to `rejected-*.jsonl`;
  rows queued at exit go to `spill-*.jsonl`. Each line keeps the full row,
  the reason (redacted), the attempt count and the table it was meant for.
  Files go to a subdirectory of `deadLetterDir` named after that table
  (`project.dataset.table`, percent-encoded where a name needs it). Each
  failure writes a new file (the mods file API has no append) of at most
  3 MiB of UTF-8, under the 4 MiB the API reads or writes per file; a row too
  large for a file on its own has its payload columns cut to fit and
  `is_truncated` set.
* **Backfill:** `/bqaa-backfill` resends the files in the configured table's
  subdirectory to that table, and checks each line's recorded table first: a
  line for another table stays in its file as written, and rows parked for
  another table are sent only by a session configured for that table. `spill`
  and `retry` files are also replayed 15 seconds after a session starts and
  once BigQuery recovers in a session that parked rows. A file whose rows all
  land is truncated to zero bytes (the API has no delete; empty files are safe
  to remove). A file over 4 MiB, which the API cannot read, is reported by
  `/bqaa-status` and the backfill instead of being passed over. Rows that fail
  again stay, and a per-file lease in `$.store` keeps two sessions from
  replaying the same file at once (best effort; `event_id` dedups the rest).
* **Fail open:** a hook's bookkeeping runs behind `.catch` or inside `try`;
  the writer never throws into a hook; every failure path ends in sent, on
  disk, or counted as dropped. An environment variable a policy refuses reads
  as unset, `BQAA_ACCESS_TOKEN` included (the token command takes over).

## Commands

All three run immediately, even while the agent is working, and print counts,
never payloads or tokens (the agent reads a command's output too).

* `/bqaa-status`: target table, queue depth, rows captured / sent /
  dead-lettered / refused / spilled / dropped this session, retries, backoff,
  the last error (redacted), the configured table's dead-letter files, how
  many files elsewhere in the directory belong to other tables, any file too
  large to read, the last backfill.
* `/bqaa-flush`: send the queue now instead of at the next interval.
* `/bqaa-backfill`: resend the configured table's dead-letter files in the
  background; a dim transcript line reports the result.

When BigQuery refuses rows or retries run out, the mod also sets a status line
under the prompt (`⚠ bigquery-agent-analytics-mod: …`) until the next
successful send.

## Privacy and security

The table receives your prompts, the model's visible answers, tool arguments
and tool results (the text the model read), cut to `maxPayloadChars` per
column. Treat the dataset like the transcripts it mirrors.

* **Redaction (best effort):** values under credential-like keys become
  `[REDACTED]`. A key matches when its name, with case and punctuation
  removed, contains `password`, `passwd`, `passphrase`, `secret`, `apikey`,
  `accesskey`, `privatekey`, `signingkey`, `authorization`, `credential`,
  `signature` or `cookie`, ends in `token`, is `auth`, `sig`, `jwt` or
  `bearer`, or has ADK's `temp:` prefix: `my_api_key`, `X-Amz-Security-Token`
  and `sessionCookie` all match, while token counts such as `max_tokens` are
  numbers and stay. Free text is scrubbed of private-key blocks,
  provider-style `sk-` keys, AWS access key ids, Google API keys and OAuth
  tokens, GitHub/GitLab/npm/Slack/Stripe tokens, JWTs, `Bearer`/`Basic`
  credentials, passwords in URLs, signed-link and token query parameters
  (`X-Goog-Signature`, `X-Goog-Credential`, `X-Amz-Signature`,
  `X-Amz-Credential`, `X-Amz-Security-Token`, `sig`, `access_token`, `key`,
  ...) and assignments whose key matches by the same rules as a structured
  key: `key: value`, `key=value`, `"key": "value"` and serialized JSON at any
  depth (a tool result's text included). A quoted value goes whole, to its
  closing quote, and so does an object or list under such a key; an unquoted
  value after `:` goes to the end of its line, after `=` to the next space.
  Counts, booleans and `null` stay. Patterns cannot catch every secret; do not
  rely on them alone.
* **Diagnostics:** error text from BigQuery, the token command or the file
  system is redacted before it is cut (including where BigQuery's error
  messages and per-row insert errors are first held to their length), kept
  or shown: in dead-letter reasons,
  the status line, `/bqaa-status`, backfill reports, the debug log and the
  transcript. A failing token command is named by its program only, never its
  arguments.
* **Truncation:** each payload column is held to `maxPayloadChars`,
  error messages to 4,096 characters; the copy is built within that budget, so
  a multi-megabyte tool input costs the hot path milliseconds (a test checks
  under 100 ms for a 2,760,000-character Write). Cut rows have
  `is_truncated = true`.
* **Local files:** dead-letter and dry-run files hold the same redacted rows
  as the table; they are written with your user's default permissions.
* **Token:** memory only; never written to rows, files, logs or status text.

## Testing

```bash
claude plugin validate plugins/bigquery-agent-analytics-mod
cd plugins/bigquery-agent-analytics-mod && claude plugin test
```

The test command runs the `tests/*.test.ts` files against the host CLI's own
test kit, with no session, sign-in, GCP or network: `$.http.fetch`,
`$.process.run`, `$.fs` and `$.store` are stubbed, and `mock.clock` drives the
timers; the `$.fs` stubs measure files in UTF-8 bytes and refuse a file over
4 MiB, as the host does. 76 tests cover the captured rows and their spans, the
non-blocking rules (`session.end` included), the queue bound, retries,
timeouts, token refresh, table creation, partial inserts, 2xx answers that
are not valid insertAll responses, dead-letter files,
replay that keeps two tables' rows apart, backfill, the exit spill and its
time bound, multibyte rows held to the file limit in bytes, dry run,
redaction (credential keys by stem, the same key rules in text and serialized
tool results, signed links, credentials across a length cap, and every
diagnostic sink),
truncation (identifying fields survive a cut), refused environment reads
(`BQAA_ACCESS_TOKEN` included), a re-fired `session.start`, and
configuration.

## Limitations

* Mods are early access; the events and `$` methods can change between
  host CLI releases. Tested with 2.1.296.
* Writes use `tabledata.insertAll` (the legacy streaming API) because the
  Storage Write API is gRPC only and `$.http.fetch` is HTTP with text bodies.
  insertAll's quotas and pricing apply, and its `insertId` dedup is best
  effort; use `event_id` in queries.
* `LLM_REQUEST` rows carry the user's prompt on a turn's first request and no
  conversation history or system prompt (reading them per request would put
  `$.session.messages()` on the hot path).
* `content_parts` is always empty; attachments on a prompt are listed by type
  only.
* A tool's `total_ms` is the whole `tool.call` chain: permission prompts
  (flagged), `PreToolUse` hooks and the tool. A model request's `total_ms` is
  the stream through the mod's hook; `time_to_first_token_ms` is the first
  text, thinking or tool chunk.
* A subagent's span hangs under its turn, not under the `Agent` tool call that
  started it (the events carry no reliable link between the two).
* No `HITL_*` rows: the host CLI exposes the permission prompt but not a
  reliable answer to it, and a request row without a completion would read as
  unanswered.
* Rows in the in-memory queue are lost if the hooks module reloads (a
  `--plugin-dir` edit, `/reload-plugins`) or the hooks worker crashes:
  at most one flush interval's worth, plus any batch in backoff.
* Rows queued at exit reach BigQuery when a later session starts (15 seconds
  in) or `/bqaa-backfill` runs; until then they wait in a spill file.
* Rows parked for a table are sent only by a session configured for that
  table: after switching tables, run with the old table's settings to send
  what it left behind.
* `$.fs` cannot append or delete: one file per failure, truncated rather than
  removed after backfill.
* Timestamps have millisecond precision.
* An organization's web-fetch policy or `allowManagedModsOnly` can stop the
  mod; `/bqaa-status` and the debug log (start the CLI with `--debug`) say why.

## Files

```
.claude-plugin/plugin.json   manifest and userConfig
hooks/hooks.json             names the hooks module
hooks/register.ts            hooks and $ wiring
hooks/lib/tracer.ts          event -> BQAA row, ids and spans
hooks/lib/rows.ts            row builder, BQAA schema
hooks/lib/sanitize.ts        redaction, truncation
hooks/lib/queue.ts           bounded queue
hooks/lib/writer.ts          background writer, retries, dead letter, backfill, exit spill
hooks/lib/bigquery.ts        insertAll / tables.insert requests, answer classification
hooks/lib/deadletter.ts      dead-letter file format, files sized in UTF-8 bytes
hooks/lib/config.ts          options and environment
hooks/lib/status.ts          /bqaa-status text
sql/                         DDL and sample queries
examples/sample-rows.jsonl   fixture output
tests/                       plugin-test suites
```
