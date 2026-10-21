-- The questions docs/value.md answers, one query each: a developer (V1, V2),
-- a team lead or administrator (V3 to V6) and a platform team (V7).
-- Placeholders as in sample_queries.sql: {PROJECT}, {DATASET}, {TABLE} and
-- the parameters @start and @end, which
-- bigquery-agent-analytics-skill/scripts/run_bq.py fills and binds. It runs
-- with your Application Default Credentials, not the mod's settings, and
-- stops a query that would bill more than --max-gb (1 GB by default). Pass
-- one query at a time:
--
--   python3 bigquery-agent-analytics-skill/scripts/run_bq.py \
--     --project my-gcp-project --dataset agent_analytics --table agent_events \
--     --start 2026-10-01 --end 2026-10-31 --max-gb 1 "<one query below>"
--
-- Add --dry-run to see the bytes a query would scan first. Every query reads
-- the raw table, so it needs read access to it (an administrator, or your
-- own sandbox); readers without it use the views in <dataset>_reporting.
--
-- Every query reads only this mod's rows (attributes.writer.plugin), except
-- V7, which compares producers on purpose, and keeps one row per event_id:
-- a row resent after an ambiguous timeout, or by a replay, has the same
-- event_id. Rows without an event_id (other producers) are all kept.
-- tests/queries.live.py runs each one on a synthetic fixture.

-- V1. Developer: my sessions at a glance. Per session: when it started, how
--     long it was open, its prompts, turns, model requests, tool calls, the
--     tool calls that failed, and its tokens. Add AND user_id = 'you' for
--     yours (user_id is the login name the machine reported).
WITH events AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  session_id,
  ANY_VALUE(user_id) AS user_id,
  MIN(timestamp) AS started_at,
  ROUND(TIMESTAMP_DIFF(MAX(timestamp), MIN(timestamp), SECOND) / 60, 1) AS minutes_open,
  COUNTIF(event_type = 'USER_MESSAGE_RECEIVED') AS prompts,
  COUNTIF(event_type = 'INVOCATION_STARTING') AS turns,
  COUNTIF(event_type = 'LLM_RESPONSE') AS model_requests,
  COUNTIF(event_type = 'TOOL_COMPLETED') AS tool_calls,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND status = 'ERROR') AS failed_tool_calls,
  SUM(IF(event_type = 'LLM_RESPONSE', SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens') AS INT64), 0)) AS tokens
FROM events
GROUP BY session_id
ORDER BY started_at DESC;

-- V2. Developer: where each turn's time went. The turn's total (NULL when
--     no end of turn was recorded), the time in model requests and in tool
--     calls (a permission prompt's wait is part of its tool call's), and
--     the tool calls that asked for permission. The parts can add up to
--     more than the turn: a tool call can run beside a model request.
WITH events AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
    AND invocation_id IS NOT NULL
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  session_id,
  invocation_id,
  MIN(timestamp) AS started_at,
  MAX(IF(event_type IN ('INVOCATION_COMPLETED', 'INVOCATION_ERROR'), SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64), NULL)) AS turn_ms,
  SUM(IF(event_type = 'LLM_RESPONSE', SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64), 0)) AS model_ms,
  SUM(IF(event_type = 'TOOL_COMPLETED', SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64), 0)) AS tool_ms,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND JSON_VALUE(attributes, '$.permission_requested') = 'true') AS permission_prompts
FROM events
GROUP BY session_id, invocation_id
ORDER BY started_at DESC;

-- V3. Team lead: adoption against a roster. Per day: the people enrolled
--     (a table of their login names that you keep, team_roster, with one
--     user_id column), how many of them have rows, their sessions and
--     turns, and the sessions from no one on the roster or with no user_id.
--     A person with no rows is shown as not seen, not as zero use: they
--     may not have used the agent, or their sessions may not be recorded.
--     Under impersonation leave userIdFromCredentials off, or every row
--     carries the service account and the roster matches no one.
WITH events AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
),
roster AS (
  SELECT DISTINCT user_id FROM `{PROJECT}.{DATASET}.team_roster`
)
SELECT
  DATE(e.timestamp) AS day,
  (SELECT COUNT(*) FROM roster) AS enrolled,
  COUNT(DISTINCT IF(r.user_id IS NOT NULL, e.user_id, NULL)) AS enrolled_seen,
  (SELECT COUNT(*) FROM roster) - COUNT(DISTINCT IF(r.user_id IS NOT NULL, e.user_id, NULL)) AS enrolled_not_seen,
  COUNT(DISTINCT IF(r.user_id IS NOT NULL, e.session_id, NULL)) AS enrolled_sessions,
  COUNTIF(r.user_id IS NOT NULL AND e.event_type = 'INVOCATION_STARTING') AS enrolled_turns,
  COUNT(DISTINCT IF(r.user_id IS NULL, e.session_id, NULL)) AS other_sessions
FROM events AS e
LEFT JOIN roster AS r ON e.user_id = r.user_id
GROUP BY day
ORDER BY day DESC;

-- V4. Team lead: estimated cost per session and model. Tokens split the
--     way they are priced (uncached input, cache reads, cache writes,
--     output) times the rates you put in `rates`: USD per million tokens,
--     one row per model id as the model column shows it, with the date and
--     source of the rates. An estimate, not a bill: a model with no rate
--     row has no cost (NULL), not zero, and discounts and other charges
--     are not counted.
WITH rates AS (
  -- rates: begin
  SELECT * FROM UNNEST([
    STRUCT('your-model-id' AS model, DATE '2026-01-01' AS rates_as_of, 'where these rates come from' AS rates_source,
           0.0 AS input_usd, 0.0 AS cache_read_usd, 0.0 AS cache_write_usd, 0.0 AS output_usd)
  ])
  -- rates: end
),
responses AS (
  SELECT
    session_id,
    JSON_VALUE(attributes, '$.model') AS model,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.input_tokens') AS INT64) AS input_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.cache_read_input_tokens') AS INT64) AS cache_read_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.cache_creation_input_tokens') AS INT64) AS cache_write_tokens,
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.output_tokens') AS INT64) AS output_tokens
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  r.session_id,
  r.model,
  COUNT(*) AS model_requests,
  SUM(IFNULL(r.input_tokens, 0)) AS input_tokens,
  SUM(IFNULL(r.cache_read_tokens, 0)) AS cache_read_tokens,
  SUM(IFNULL(r.cache_write_tokens, 0)) AS cache_write_tokens,
  SUM(IFNULL(r.output_tokens, 0)) AS output_tokens,
  ANY_VALUE(p.rates_as_of) AS rates_as_of,
  ROUND((SUM(IFNULL(r.input_tokens, 0)) * ANY_VALUE(p.input_usd)
    + SUM(IFNULL(r.cache_read_tokens, 0)) * ANY_VALUE(p.cache_read_usd)
    + SUM(IFNULL(r.cache_write_tokens, 0)) * ANY_VALUE(p.cache_write_usd)
    + SUM(IFNULL(r.output_tokens, 0)) * ANY_VALUE(p.output_usd)) / 1e6, 6) AS estimated_usd
FROM responses AS r
LEFT JOIN rates AS p USING (model)
GROUP BY r.session_id, r.model
ORDER BY r.session_id, r.model;

-- V5. Team lead: the tools people use most. Per tool: the people who used
--     it, its calls, and the share of calls that failed, asked for
--     permission, were rejected at the permission prompt, or were denied by
--     a hook. Those two are not all denials: a call that a permission rule
--     blocks before it runs may leave no row.
WITH tools AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'TOOL_COMPLETED'
    AND timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  JSON_VALUE(content, '$.tool') AS tool,
  COUNT(DISTINCT user_id) AS people,
  COUNT(*) AS calls,
  ROUND(COUNTIF(status = 'ERROR') / COUNT(*) * 100, 1) AS error_pct,
  ROUND(COUNTIF(JSON_VALUE(attributes, '$.permission_requested') = 'true') / COUNT(*) * 100, 1) AS asked_pct,
  ROUND(COUNTIF(JSON_VALUE(attributes, '$.permission_decision') = 'reject') / COUNT(*) * 100, 1) AS rejected_pct,
  ROUND(COUNTIF(JSON_VALUE(attributes, '$.denied') = 'true') / COUNT(*) * 100, 1) AS denied_by_hook_pct
FROM tools
GROUP BY tool
ORDER BY calls DESC, tool;

-- V6. Team lead: errors over time. Per day, each count beside its own
--     denominator: turns and those that ended in an error, model requests
--     (answered or failed) and the failed ones, tool calls and the failed
--     ones, and the tool calls rejected at a prompt or denied by a hook.
WITH events AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  DATE(timestamp) AS day,
  COUNTIF(event_type IN ('INVOCATION_COMPLETED', 'INVOCATION_ERROR')) AS turns,
  COUNTIF(event_type = 'INVOCATION_ERROR') AS failed_turns,
  COUNTIF(event_type IN ('LLM_RESPONSE', 'LLM_ERROR')) AS model_requests,
  COUNTIF(event_type = 'LLM_ERROR') AS failed_model_requests,
  COUNTIF(event_type = 'TOOL_COMPLETED') AS tool_calls,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND status = 'ERROR') AS failed_tool_calls,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND JSON_VALUE(attributes, '$.permission_decision') = 'reject') AS rejected_tool_calls,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND JSON_VALUE(attributes, '$.denied') = 'true') AS denied_by_hook
FROM events
GROUP BY day
ORDER BY day DESC;

-- V7. Platform team: coding-agent sessions beside ADK agents and the
--     settings-hook tracer. The producers share the agent_events schema,
--     so one table, or a UNION over two, holds them all. Per producer and
--     agent: sessions, model requests, tokens and the share of rows in
--     error. Normalized: rows with no writer are named for ADK, and an ADK
--     response's tokens are read from total_token_count when total_tokens
--     is missing. Other columns differ by producer and are left out.
WITH events AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
)
SELECT
  IFNULL(JSON_VALUE(attributes, '$.writer.plugin'), 'adk (no writer)') AS producer,
  agent,
  COUNT(DISTINCT session_id) AS sessions,
  COUNTIF(event_type = 'LLM_RESPONSE') AS model_requests,
  SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens') AS INT64),
    SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_token_count') AS INT64)), 0)) AS tokens,
  ROUND(COUNTIF(status = 'ERROR') / COUNT(*) * 100, 1) AS error_row_pct
FROM events
GROUP BY producer, agent
ORDER BY producer, agent;
