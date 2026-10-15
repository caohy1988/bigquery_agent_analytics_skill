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
  calls `next(e)`, records what it saw into an in-memory queue (synchronous,
  bounded work), and returns what `next` gave it, unchanged. The one other
  call a hook waits on is the host's `$.session.id()`, read for each event
  (no network, no process; see Ids and spans).
* No hook waits on the network or a process; a background writer driven by
  `$.clock` timers does that. Two lifecycle hooks do bounded work of their own
  before passing their event on: `session.start` sets the writer up and
  registers the three commands, and `session.end` writes what is still queued
  to a spill file, waiting at most `BQAA_EXIT_FLUSH_MS` (800 ms) inside the
  host's end-of-session bound. That write is the only wait on the disk.
* If the mod's own code throws, the event goes on as if the mod were not
  installed (fail open). The six observers the validator lists as gating
  hooks (`classic.SessionStart`, `classic.SubagentStart`,
  `classic.PermissionRequest`, `prompt.submit`, `telemetry.log`,
  `tool.call`) carry a `.catch(($, e, next) => next(e))`; the other hooks
  run their bookkeeping inside `try` blocks, so it cannot throw into the
  event.
* One opt-in exception: with `onAuthFailure: block`, `prompt.submit` checks
  the credentials before a prompt goes in, within its hook budget, and
  refuses the prompt while none work (see
  [If no credentials work](#if-no-credentials-work)). That check fails
  closed, its `.catch` included. In the default `warn` mode nothing waits.

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
 prompt.submit ────────┤   hook: next(e),             Tracer: event -> BQAA row
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
                                                          │ 401: a fresh token, one retry at once
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

[`setup.sh`](setup.sh) creates the rest with the `bq` CLI, and is safe to run
again:

* the dataset, if it is missing;
* the table, from [`sql/agent_events_ddl.sql`](sql/agent_events_ddl.sql);
* a views dataset (default `<dataset>_reporting`);
* the usage views (see [Views](#views)).

```bash
BQAA_PROJECT_ID=my-gcp-project BQAA_DATASET=agent_analytics ./plugins/bigquery-agent-analytics-mod/setup.sh --dry-run
```

`--dry-run` prints the commands and the SQL. Without it, they run.

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
| `onAuthFailure` | | `warn` | `warn`: while rows cannot be written for lack of credentials or permission, the mod shows a notice above the prompt with the fix. `block`: also refuse prompts while no credentials work. See [If no credentials work](#if-no-credentials-work). |
| `userIdFromCredentials` | | `false` | Off by default, since it is personal data. When on, `user_id` is the verified email of the access token's account. See [Identity](#identity). |
| `recordHostname` | | `false` | Off by default, since it is personal data. When on, `session_metadata.host_name` holds the machine's host name. See [Identity](#identity). |

Advanced, environment only:

| Variable | Default | What it does |
| --- | --- | --- |
| `BQAA_ACCESS_TOKEN` | unset | Use this token as is (re-read every 5 minutes) instead of running the command |
| `BQAA_USER_ID` | `$USER` / `$USERNAME` | `user_id` column (with `userIdFromCredentials` on, the token's account takes its place once known) |
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
service-account impersonation for it). The token is kept in memory only and
reused for 45 minutes. On a 401 the writer gets a fresh token and retries
once at once. The token goes only to `bigquery.googleapis.com`, and, with
`userIdFromCredentials` on, to Google's token information endpoint
(`oauth2.googleapis.com/tokeninfo`) in a POST body. `$.http.fetch` drops the
`Authorization` header on a cross-origin redirect. `BQAA_ACCESS_TOKEN` skips
the command. A
service-account key file cannot be used directly: the mods environment has
`crypto.subtle.digest` but no signing, so wrap it in a command that prints a
token. The type declarations mark `$.process.run` as CLI only; where it is
not available, set `BQAA_ACCESS_TOKEN`.

The identity needs `roles/bigquery.dataEditor` on the dataset (insert rows,
create the table). The repo's `setup_gcp_prereqs.py` grants it.

### If no credentials work

Rows stop being written when no Google credentials work, or when the identity
lacks permission on the dataset. That happens when:

* the token command fails (never signed in, or a sign-in expired);
* BigQuery answers 401 even to a fresh token;
* BigQuery answers 403 access denied.

While that lasts, the mod shows a notice:

* **The band above the prompt** (terminal and desktop) says what is wrong
  and the fix for the token source in use, for example `run: gcloud auth
  application-default login`. For a missing permission it names the role to
  ask for on which dataset. It also counts the rows waiting: queued, in
  flight, or parked on disk since the problem began. It keeps what other
  mods draw there below it, and gives the band up to a survey.
* **A toast** comes once per kind of problem in a session.
* **A dim transcript line** comes once per kind of problem, with the reason
  (redacted). A `-p` or SDK host receives it as `ui_log`.
* **The status line** shows the same notice.
* **`/bqaa-status`** adds a `notice` line.

The next successful send clears the notice. Recovery is quick:

* While credentials are the problem, retries come at least every 30
  seconds.
* A prompt starts a retry at once, from a timer, so signing in from the
  session (`! gcloud auth application-default login`) is enough.
* Rows parked meanwhile follow on their own once BigQuery takes rows again
  (`BQAA_AUTO_BACKFILL`).
* Rows refused for a missing permission wait for `/bqaa-backfill`, and the
  transcript says so when rows flow again.

`onAuthFailure: block` adds enforcement. While no credentials work, each
prompt is refused before it reaches the model, with the fix as the reason.
How the check works:

* **It is quick.** It needs no request while a token is at hand and no
  credentials problem stands. Otherwise it gets a token. While a credentials
  problem stands, it then asks BigQuery about that token with a `tables.get`
  of the table's id. Any answer other than 401 counts as working
  credentials, and clears the notice.
* **It fits the hook's budget.** It takes at most 8 seconds of the hook's
  10.
* **It fails closed.** No token in time refuses, and so does a check that
  cannot reach BigQuery while a credentials problem stands. If the hook
  throws before passing the prompt on, its `.catch` refuses too.
* **A permission problem never blocks**, so that one wrong grant cannot stop
  every prompt.
* **Capture off or a dry run blocks nothing.** Capture on with no project
  or dataset blocks, and the reason says what to set.

`block` is enforcement only where people cannot change the mod's options or
remove it: install it through managed settings. `BQAA_TRACE_ENABLED=false`
also turns capture, and so the check, off. The host reads a value other than
`warn` or `block` in a settings file as `warn`, and says so.

### Identity

Both options are off by default, since each adds personal data to the rows.

* **`userIdFromCredentials`** sets `user_id` to the account of the access
  token each row is sent with.
  * The writer looks up the account of each token it uses, at Google's
    token information endpoint, with the token in a POST body. A new token
    is a new credential and is looked up again: a refresh, the fresh token
    after a 401 (the retry carries the new account), or another
    `BQAA_ACCESS_TOKEN`.
  * A lookup that answers late, for an older token, never replaces the
    account of a newer one.
  * It takes the email only if the endpoint says it is verified. A token
    without the email scope gives none.
  * A failed lookup is retried after ten minutes. Until then, and while the
    current token's account is not known, rows carry the configured
    `user_id`, never an account looked up for another token.
  * A row parked on disk carries the account of the token in use when it was
    parked, and keeps it when replayed. Rows an earlier session parked are
    sent as they were.
  * A token that expires, or that BigQuery refuses, is dropped together with
    the account looked up for it. Rows parked while no fresh token comes
    (at retry exhaustion or at exit) carry the configured `user_id`, never
    the expired token's account.
  * The address goes to the table, and to rows parked on disk. It never
    goes to a log line or a command's output.
* **`recordHostname`** runs the `hostname` command once, from a timer.
  * Rows built after it answers carry `session_metadata.host_name`, from
    the first turn on (`INVOCATION_STARTING`).
  * A name that is not a plain host name is left out.
  * On macOS the default host name often includes the owner's name.

## What it writes

### Event mapping

| Host event (mod hook) | BQAA `event_type` | `content` | Notable `attributes` / `latency_ms` |
| --- | --- | --- | --- |
| `classic.SessionStart` | `STATE_DELTA` | `{"session_start": true}` | `state_delta.start_source` (`startup`, `resume`, `clear`, `compact`, `fork`), `model`, `session_metadata` (project, cwd, `host_version`) |
| `prompt.submit` (after it entered) | `USER_MESSAGE_RECEIVED` | `{"text_summary": prompt}` | `prompt_origin`, `submitted_during_turn` |
| `turn.start` (main loop) | `INVOCATION_STARTING` | `{}` | `turn_number`, `session_metadata` |
| `turn.step`, before the request | `LLM_REQUEST` | `{"prompt": [{"role": "user", "content": …}]}` on a turn's first request, `{"prompt": []}` after | `model`, `llm_config.effort`, `step_index`, `message_count` |
| `turn.step`, response | `LLM_RESPONSE` | `{"tool_uses": [names], "response": text}` | `model`, `usage_metadata`, `finish_reason`; `latency_ms.total_ms`, `time_to_first_token_ms` |
| `turn.step`, no response | `LLM_ERROR` (status `ERROR`) | `null` | `latency_ms.total_ms` |
| `tool.call`, before | `TOOL_STARTING` | `{"tool", "tool_origin", "args"}` | `tool_use_id` |
| `tool.call`, after | `TOOL_COMPLETED` | `{"tool", "tool_origin", "result"}` | `latency_ms.total_ms`; status `ERROR` with `error_message` for a tool error or a hook's deny (`denied: true`); `permission_requested`; `permission_decision`, `permission_decision_source` |
| `classic.SubagentStart` | `AGENT_STARTING` | `{"agent_type", "agent_id"}` | `agent` column = subagent type |
| `turn.complete` (subagent) | `AGENT_COMPLETED` / `AGENT_ERROR` | `{}` | `usage_metadata` (the subagent's totals), `latency_ms.total_ms` |
| `turn.complete` (main loop) | `AGENT_RESPONSE` (if it answered) and `INVOCATION_COMPLETED` / `INVOCATION_ERROR` | `{"response": answer}` / `{}` | `finish_reason`, `is_aborted`, `step_count`, turn `usage_metadata`, `latency_ms.total_ms` |
| `classic.PermissionRequest` | (no row) | | sets `permission_requested` on the waiting tool's `TOOL_COMPLETED` |
| `telemetry.log` (`tool_decision`, a collector record) | (no row) | | sets `permission_decision` (`accept`, `reject`) and `permission_decision_source` (`config`, `hook`, `user_temporary`, `user_permanent`, `user_abort`, `user_reject`) on that call's `TOOL_COMPLETED` |
| `session.end` | `STATE_DELTA` | `{"session_end": true}` | `state_delta.reason`, `trace_count`, `duration_ms` |

The host can raise `classic.SessionStart` before `session.start` has read
the environment and the host version; its row waits until it has, keeping
the event's time, so it carries the same user, agent name, writer mode and
host version as the rows after it. A subagent's run starts with a
`turn.start` of its own that names its loop (`agentId`): it writes no row,
does not count as a turn, and leaves the main turn running.

`usage_metadata` carries the names this repo's tracing plugin and analysis
skill read (`prompt_tokens` = input + cache read + cache write,
`completion_tokens`, `total_tokens`) and the four counts as the API reports
them (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
`cache_creation_input_tokens`). Token counts come from the engine's
`turn.step` and `turn.complete` results.

In `content` and `attributes`, values under keys that are not on the
allowlist are redacted, inside `args` and `result` too (see
[Privacy and security](#privacy-and-security)).

The permission decision comes from the host's own `tool_decision`
collector record. That record reaches mods with no telemetry settings
(checked live with host 2.1.299), and is matched to its call by
`tool_use_id`. The mod passes every collector record on unchanged, and
ignores one that a later hook refuses.

* An accept arrives while its call runs.
* A rejection arrives just after its call has returned. So once the host's
  records are arriving, a call that ends without its decision waits up to
  2 seconds for it. Its row keeps the time the call ended.
* A call whose decision never comes is written without one. So is one
  still waiting when the session ends.

A failed tool is `TOOL_COMPLETED` with status `ERROR`, as in the tracing
plugin and the analysis skill's failure-rate query (ADK itself uses
`TOOL_ERROR`). Every row has `attributes.writer`
(`{"plugin": "bigquery-agent-analytics-mod", "version", "label", "agent", "mode"}`),
`root_agent_name` and `source: "coding_agent"`.

### Ids and spans

* `session_id`: the host CLI's session id, read again for each event, so the
  rows after `/clear`, `/resume` or `/branch` carry the new one, even where
  the classic hooks do not run (see Limitations). If the host refuses that
  read after such a change, rows carry no session id rather than the old one.
* `invocation_id`: the engine's turn id; a subagent's rows carry the turn that
  started it.
* `trace_id`: one 32-hex trace per main-loop turn; a subagent started in that
  turn shares it.
* `span_id` / `parent_span_id`: the turn's span is the root; each model
  request is a span under it (its `LLM_REQUEST` and `LLM_RESPONSE` share it);
  a tool call is a span under the model request that asked for it; a subagent
  has its own span under the turn, and its requests and tools nest under that.
  Each run of a subagent's loop (a teammate woken again, say) gets a span of
  its own under the main turn it runs in.
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

### Views

`setup.sh` makes two views in the views dataset, from the `LLM_RESPONSE`
rows this mod wrote (`attributes.writer.plugin` is
`bigquery-agent-analytics-mod`): the main loop's and the subagents' model
requests. The table can be shared with ADK agents and the settings-hook
plugin. Other writers can name their token counts differently (ADK's
`prompt_token_count`, for one), so their rows are left out. That way
requests, sessions and tokens always count the same rows.

* [`daily_usage_by_model`](sql/views/daily_usage_by_model.sql): per day and
  model, model requests, sessions and the token counts.
* [`daily_usage_by_user`](sql/views/daily_usage_by_user.sql): per day and
  `user_id`, sessions, model requests and the token counts.

The details below were checked on BigQuery itself:

* Each view keeps one row per `(timestamp, event_id)`. A row sent twice has
  the same `event_id` and timestamp.
* A filter on `day` still reaches the table's day partitions: a dry run with
  one day's filter reads 0 bytes of the other days. Deduplicating on
  `event_id` alone would read the whole table.
* Over a fixture shared by several writers, both views count only this
  mod's requests, sessions and tokens. That run read literal rows, with no
  table, and so does [`tests/views.test.py`](tests/views.test.py) offline.

The rows carry token counts, not prices, so the views report tokens. Keep
the views in a dataset of their own, as `setup.sh` does, so the identities
that write rows need no access to them.

```sql
SELECT day, model, model_requests, input_tokens, cache_read_input_tokens, output_tokens
FROM `my-gcp-project.agent_analytics_reporting.daily_usage_by_model`
WHERE day >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
ORDER BY day, model
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
  exponentially (1 s doubling to 60 s, with jitter; at most 30 s while no
  credentials work) and retry a batch up to 3 times with the same
  `insertId`s. A 401 gets a fresh token and one retry at once, and only a
  second 401 counts as a failure. A 2xx
  answer counts as delivered only when it is a valid insertAll response: a
  body cut off at the response limit, a non-JSON page or an `insertErrors`
  entry that names no row of the batch leaves the outcome unknown, so the rows
  are retried the same way and parked if the retries run out.
* **Dead letter:** rows that exhaust retries go to `retry-*.jsonl`; rows
  BigQuery or the configuration refuses (400, 403 access denied, missing
  dataset, an invalid row reported by insertAll) go to `rejected-*.jsonl`;
  rows queued at exit go to `spill-*.jsonl`. Each line keeps the full row,
  the reason (redacted), the attempt count and the table it was meant for.
  Each file ends with a completion record, written after its rows: how many
  lines come before it and their checksum (FNV-1a). Files go to a subdirectory of `deadLetterDir` named after that table
  (`project.dataset.table`, percent-encoded where a name needs it). Each
  failure writes a new file (the mods file API has no append) of at most
  3 MiB of UTF-8, under the 4 MiB the API reads or writes per file; a row too
  large for a file on its own has its payload columns cut to fit and
  `is_truncated` set.
* **Backfill:** `/bqaa-backfill` resends the files in the configured table's
  subdirectory to that table, and checks each line's recorded table first: a
  line for another table is kept as written, and rows parked for another
  table are sent only by a session configured for that table. `spill` and
  `retry` files are also replayed 15 seconds after a session starts and once
  BigQuery recovers in a session that parked rows. A replay reads a file
  only when its completion record is there and matches every line above it:
  the API's writes are not atomic, so another session can read a file
  part-written, and the record is what marks a file whole. A file without a
  matching record (still being written, or left by a writer that stopped
  part-way) is kept as it is, never read or emptied, and `/bqaa-status`
  lists it. A file whose rows all land is truncated to zero bytes (the API
  has no delete; empty files are safe to remove). What a replay leaves (rows
  that fail again, other tables' lines, lines it cannot parse) is written to
  new files first, each with its completion record, and only then is the
  replayed file truncated: the API has no rename either, so a write that
  fails leaves that file as it was (rows sent meanwhile may go again;
  `event_id` dedups them). A file over 4 MiB, which the API cannot read, is
  reported by `/bqaa-status` and the backfill instead of being passed over. A
  per-file lease in `$.store` keeps two sessions from replaying the same file
  at once (best effort; `event_id` dedups the rest).
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
  large to read or without a completion record, the last backfill.
* `/bqaa-flush`: send the queue now instead of at the next interval.
* `/bqaa-backfill`: resend the configured table's dead-letter files in the
  background; a dim transcript line reports the result.

When BigQuery refuses rows or retries run out, the mod also sets a status line
under the prompt (`⚠ bigquery-agent-analytics-mod: …`) until the next
successful send. While no credentials work or a permission is missing, that
line, the band above the prompt and `/bqaa-status` give the fix (see
[If no credentials work](#if-no-credentials-work)).

## Privacy and security

The table receives your prompts, the model's visible answers, tool arguments
and tool results (the text the model read), cut to `maxPayloadChars` per
column. Treat the dataset like the transcripts it mirrors.

* **Allowlist:** in `content` and `attributes`, at any depth, and in JSON
  found in their text, a value is kept only under a key on the list in
  [`hooks/lib/allowlist.ts`](hooks/lib/allowlist.ts); under any other key it
  becomes `[REDACTED]`, whatever it is: a string, a number, a boolean, a list
  or an object (`null` stays). Keys are compared by their words, so
  `inputTokens` and `INPUT_TOKENS` are `input_tokens`. The list:
  * structure and telemetry: `event_type`, `timestamp`, `status`,
    `event_id`, `invocation_id`, `trace_id`, `span_id`, `parent_span_id`,
    `agent`, `agent_id`, `agent_type`, `root_agent_name`, `subagent_type`,
    `subagent_turn_id`, `source_turn_id`, `tool_use_id`, `tool`,
    `tool_name`, `tool_origin`, `tool_uses`, `server_tool_uses`, `model`,
    `model_version`, `llm_config`, `effort`, `usage_metadata`,
    `prompt_tokens`, `completion_tokens`, `total_tokens`, `input_tokens`,
    `output_tokens`, `cache_read_input_tokens`,
    `cache_creation_input_tokens`, `max_tokens`, `latency_ms`, `total_ms`,
    `time_to_first_token_ms`, `duration_ms`, `step_index`, `step_count`,
    `message_count`, `turn_number`, `trace_count`, `session_start`,
    `session_end`, `state_delta`, `source`, `start_source`,
    `permission_mode`, `reason`, `finish_reason`, `is_aborted`, `is_error`,
    `is_read_only`, `denied`, `inferred`, `permission_requested`,
    `permission_decision`, `permission_decision_source`,
    `submitted_during_turn`, `wait`, `prompt_origin`, `attachments`, `role`,
    `type`, `session_metadata`, `project_name`, `cwd`, `host_version`,
    `host_name`, `writer`, `plugin`, `version`, `label`, `mode`, and the
    built-in tools'
    `limit`, `offset`, `timeout`, `run_in_background`, `replace_all`,
    `head_limit`, `multiline` and `output_mode`;
  * free text: `text_summary`, `prompt`, `content`, `response`, `result`,
    `args`, `text`, `message`, `error`, `error_message`, `stdout`, `stderr`,
    `output`, and the built-in tools' `command`, `description`,
    `file_path`, `path`, `notebook_path`, `pattern`, `glob`, `query`, `url`,
    `old_string`, `new_string`, `new_source`, `plan`, `todos`, `edits` and
    `active_form`.

  So `api_keys`, `token2`, `headers`, `env` and most of an MCP tool's own
  arguments lose their values, credential or not. A kept value is still
  checked: its text goes through the two rules below. So is a name that is
  not on the list: one that holds a credential shape, a URL with user-info
  or a credential-named parameter, or a credential-named value
  (`password=…`), or is too long to scan, becomes `[REDACTED_KEY:n]`,
  numbered within its object and never one of that object's own names.
* **JSON in text:** text that looks like JSON (an object; a list that opens
  with a value, whether an object, a list, a string, a number, `true`,
  `false` or `null`, or is empty; or a JSON-encoded string whose text opens
  an object or a list) is parsed and held to the same list, at any encoding
  depth, then encoded again (compactly). Text that looks like JSON but
  cannot be parsed whole (longer than the 24,064 characters parsed at the
  default `maxPayloadChars`, or not valid JSON, such as a document cut short
  or JSON lines) is dropped: it becomes `[TRUNCATED: N chars of JSON text
  that could not be parsed and checked]`, the row is marked `is_truncated`,
  and the drop counts as a redaction. It is never scrubbed line by line.
  Text that only starts with a bracket or a quote (`[1/3] Building`,
  `[INFO] ready`, `"Hi," she said.`) does not look like JSON; `[1] first`
  does, and is dropped.
* **Free text (best effort):** text has no structure to go by; every string
  that is not JSON is scanned, all of what is kept (see Truncation). Removed: private-key blocks,
  provider-style `sk-` keys, AWS access key ids, Google API keys and OAuth
  tokens, GitHub/GitLab/npm/Slack/Stripe tokens, JWTs and `Bearer`/`Basic`
  credentials; in URLs, the user-info part and credential-named query or
  fragment parameters, and incoming-webhook URLs (Slack, Discord, Office)
  whole; and after a credential name followed by `:` or `=` (a header, a
  YAML or `.env` line, a JSON key in text, an assignment) everything to the
  end of the line, whatever it holds, including a redaction marker
  (`?name=` / `&name=` only to the next `&`). A name is a credential's when
  one of its parts, split on punctuation and camelCase and compared without
  case, is `pass`, `passwd`, `password`, `passphrase`, `pwd`, `secret`,
  `token`, `auth`, `authorization`, `cookie`, `session`, `key`, `apikey`,
  `credential(s)`, `private`, `bearer`, `jwt`, `sig` or `signature`, also
  with trailing digits or a plural `s` (`api_keys`, `access_tokens`,
  `sessions`, `token2`, `passphrase2`); when a part ends with one of the
  longer words (`rootpwd`, `accesstoken`); or when it has ADK's `temp:`
  prefix. Names on the allowlist, such as the token counts (`max_tokens`,
  `input_tokens`), are not credential names. JSON that follows other text in
  a string (a file view with line numbers, a log line) is free text, where a
  value nested on a later line than its credential name is missed. Code can
  lose a little more than the credential (`token: string` loses its type
  name). Patterns cannot catch every secret; do not rely on them alone.
* **Diagnostics:** error text from BigQuery, the token command or the file
  system goes through the same free-text rules before it is cut (including
  where BigQuery's error messages and per-row insert errors are first held to
  their length), kept or shown: in dead-letter reasons, the status line, the
  band above the prompt, toasts, `/bqaa-status`, backfill reports, the debug
  log and the transcript. A failing token command is named by its program
  only, never its arguments.
* **Truncation:** each payload column is held to `maxPayloadChars`,
  error messages to 4,096 characters; the copy is built within that budget, so
  a multi-megabyte tool input costs the hot path milliseconds (a test checks
  under 100 ms for a 2,760,000-character Write). A long string is scanned up
  to 8,192 characters past where it is cut, so a credential across the cut is
  still matched whole; anything further is dropped, never passed on unscanned.
  Cut rows have `is_truncated = true`.
* **Local files:** dead-letter and dry-run files hold the same redacted rows
  as the table; they are written with your user's default permissions.
* **Token:** memory only; never written to rows, files, logs or status text.
* **Identity:** `userIdFromCredentials` and `recordHostname` are off by
  default. When on, the rows carry the token's account email and the
  machine's host name (see [Identity](#identity)). `cwd` and `user_id` (the
  login name by default) are in the rows either way.

## Testing

```bash
claude plugin validate plugins/bigquery-agent-analytics-mod
cd plugins/bigquery-agent-analytics-mod && claude plugin test
bash tests/setup.test.sh
python3 tests/views.test.py   # needs DuckDB: python3 -m pip install duckdb
```

The test command runs the `tests/*.test.ts` files against the host CLI's own
test kit, with no session, sign-in, GCP or network: `$.http.fetch`,
`$.process.run`, `$.fs` and `$.store` are stubbed, and `mock.clock` drives the
timers; the `$.fs` stubs measure files in UTF-8 bytes and refuse a file over
4 MiB, as the host does. 183 tests cover the captured rows and their spans,
subagent runs in the order the host raises them (one invocation and one
trace for the turn, a span per run, a SubagentStart that comes late or never),
the session-start row raised before or during `session.start`'s setup,
the session id after `/clear` and `/resume` with no classic hooks (a refused
read included), the non-blocking rules (`session.end` included), the queue
bound, retries, timeouts, token refresh, table creation, partial inserts, 2xx
answers that are not valid insertAll responses, dead-letter files,
replay that keeps two tables' rows apart and writes what it leaves before
emptying a file (a failed write included), completion records (a file part
written, cut short or changed is not complete; a writer and a replayer
interleaved lose no row; a file without its record is kept and reported),
backfill, the exit spill and its time bound, multibyte rows held to the
file limit in bytes, dry run,
redaction (the allowlist at any depth and in JSON inside text, whole values
of any type, JSON nested in strings to any encoding depth, JSON-looking text
too long or broken to parse however it opens, key names that hold a
credential (in nested objects, JSON text and tool arguments), credential
names in text with their parts, endings, plural and numbered forms, URLs and
webhook URLs,
credential-named lines whatever they hold, values past 5,000 characters and
past the scanned window, credentials across a length cap, every diagnostic
sink, and each review probe through capture, delivery and the dead-letter
file),
truncation (identifying fields survive a cut), refused environment reads
(`BQAA_ACCESS_TOKEN` included), a re-fired `session.start`, and
configuration.

They also cover what happens when credentials fail:

* the band, drawn through the test kit's `$.ui.mount` (its fix, its count of
  waiting rows, what other mods draw kept, a survey left alone);
* one toast and one transcript line, the status line and `/bqaa-status`;
* the fix for each token source (the default command, gcloud's own account,
  `BQAA_ACCESS_TOKEN`, another command named by its program only);
* the notice clearing on the next send;
* a 401's immediate retry with a fresh token;
* the role to ask for on a 403;
* retries at least every 30 s, and a prompt's retry from a timer;
* `block` refusing without credentials, after a failed re-check and past
  its time bound, while letting prompts in with a token at hand, on a 403,
  with capture off and in a dry run.

And the other additions:

* permission decisions: an accept during the call, a rejection after it, a
  decision that never comes, session end, a record a later hook refuses,
  odd values, a subagent's call;
* the identity options: off by default, the lookup sent in a POST body only,
  an unverified or missing email, a retry after ten minutes, parked and
  replayed rows, the host name;
* a credential change: after a session change, a 401's fresh token for
  another account gives the retry and later rows that account; rows parked
  under the first account keep it when replayed; a new token whose account
  is unknown, or no working token, gives the configured `user_id`; a token
  that expires with no fresh one to follow leaves rows parked then (at retry
  exhaustion and at exit, also when the session ends before any send asked
  for a fresh token) with the configured `user_id`, which replay under
  another account keeps; a token that expires or is refused loses its
  looked-up account, so the same token issued again is looked up again; an
  account that a slow lookup finds after its token was let go is not used
  for the next token; and a lookup that answers late, for an older token,
  does not replace the newer account.

`tests/setup.test.sh` runs `setup.sh` against a stand-in `bq` that logs its
calls. It checks:

* the datasets, table and views it makes, on a first run and on a second;
* the fallback variables;
* that a dry run calls nothing;
* that names which are not plain ones are refused before any call;
* that the rendered views keep to this mod's rows.

`tests/views.test.py` runs both views in DuckDB. It uses five dialect
substitutions, and each must match. The fixture is a table shared by this
mod, an ADK-style writer, the settings-hook plugin, a duplicate row, another
event type and a row without `event_id`. The test checks requests, sessions
and token totals together. It also checks that without the writer filter
the same views count other producers' requests but not their tokens.

## Limitations

* Mods are early access; the events and `$` methods can change between
  host CLI releases. Tested with 2.1.296 and 2.1.299.
* A subagent's run is told from a main-loop turn by the loop id its
  `turn.start` carries (`agentId`, in the host's type declarations from
  2.1.299). A host that raised `turn.start` for a subagent without it would
  have that run recorded as a main-loop turn.
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
* No `HITL_*` rows. The answer to a permission prompt is recorded on
  `TOOL_COMPLETED` (`permission_decision`, `permission_decision_source`)
  from the host's `tool_decision` record. A rejection arriving more than
  2 seconds after its call returned is not recorded.
* Rows in the in-memory queue are lost if the hooks module reloads (a
  `--plugin-dir` edit, `/reload-plugins`) or the hooks worker crashes:
  at most one flush interval's worth, plus any batch in backoff.
* Rows queued at exit reach BigQuery when a later session starts (15 seconds
  in) or `/bqaa-backfill` runs; until then they wait in a spill file.
* Rows parked for a table are sent only by a session configured for that
  table: after switching tables, run with the old table's settings to send
  what it left behind.
* `$.fs` cannot append, rename or delete: one file per failure, truncated
  rather than removed after backfill.
* A dead-letter file without a matching completion record is never replayed.
  One left by a writer that stopped part-way, or written by an earlier
  version of this mod, stays on disk, listed by `/bqaa-status`, for a person
  to look at.
* Redaction keeps a value only under a listed key: an MCP tool's own
  arguments, structured results and JSON output, and anything else under a
  key that is not on the list, are recorded as `[REDACTED]`. Free text is
  scanned for credentials on a best-effort basis.
* Timestamps have millisecond precision.
* An organization's web-fetch policy or `allowManagedModsOnly` can stop the
  mod; `/bqaa-status` and the debug log (start the CLI with `--debug`) say why.
* Where an organization manages the host CLI, `classic.SessionStart`,
  `classic.SubagentStart` and `classic.PermissionRequest` pass over a plugin
  a person installs (`claude plugin validate` says so). Installed that way,
  the mod records no session-start row, records each subagent with an
  inferred `AGENT_STARTING` row typed `subagent`, and flags no permission
  prompts; rows still carry the current session id.

## Files

```
.claude-plugin/plugin.json   manifest and userConfig
hooks/hooks.json             names the hooks module
hooks/register.ts            hooks and $ wiring
hooks/lib/tracer.ts          event -> BQAA row, ids and spans
hooks/lib/rows.ts            row builder, BQAA schema
hooks/lib/allowlist.ts       the keys whose values a row keeps
hooks/lib/sanitize.ts        redaction, truncation
hooks/lib/queue.ts           bounded queue
hooks/lib/writer.ts          background writer, retries, dead letter, backfill, exit spill
hooks/lib/bigquery.ts        insertAll / tables.insert requests, answer classification
hooks/lib/deadletter.ts      dead-letter file format, files sized in UTF-8 bytes
hooks/lib/config.ts          options and environment
hooks/lib/status.ts          /bqaa-status text
setup.sh                     creates the dataset, table, views dataset and views (bq CLI)
sql/                         DDL and sample queries
sql/views/                   the usage views setup.sh makes
examples/sample-rows.jsonl   fixture output
tests/                       plugin-test suites, and setup.test.sh for setup.sh
```

The credential notice, `onAuthFailure`, the identity options, the
permission decisions, `setup.sh` and the views follow ideas from the
upstream reference mod (Apache-2.0). They were reimplemented, and no code
was copied.
