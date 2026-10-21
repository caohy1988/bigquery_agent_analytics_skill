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
--     tool calls that failed, the tokens recorded, and the responses that
--     recorded none (their tokens are unknown, not zero). Add
--     AND user_id = 'you' for yours (user_id is the login name the machine
--     reported).
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
  SUM(IF(event_type = 'LLM_RESPONSE', SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens') AS INT64), 0)) AS tokens,
  COUNTIF(event_type = 'LLM_RESPONSE' AND JSON_VALUE(attributes, '$.usage_metadata.total_tokens') IS NULL) AS responses_without_usage
FROM events
GROUP BY session_id
ORDER BY started_at DESC;

-- V2. Developer: where each turn's time went. The turn's total (NULL when
--     no end of turn was recorded), the time in model requests, answered or
--     failed, and in tool calls (a permission prompt's wait is part of its
--     tool call's), and the tool calls that asked for permission. A part is
--     NULL when one of its requests or calls recorded no duration: unknown,
--     not zero. The parts can add up to more than the turn: a tool call can
--     run beside a model request.
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
  IF(COUNTIF(event_type IN ('LLM_RESPONSE', 'LLM_ERROR') AND SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) IS NULL) > 0, NULL,
    IFNULL(SUM(IF(event_type IN ('LLM_RESPONSE', 'LLM_ERROR'), SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64), NULL)), 0)) AS model_ms,
  IF(COUNTIF(event_type = 'TOOL_COMPLETED' AND SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) IS NULL) > 0, NULL,
    IFNULL(SUM(IF(event_type = 'TOOL_COMPLETED', SAFE_CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64), NULL)), 0)) AS tool_ms,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND JSON_VALUE(attributes, '$.permission_requested') = 'true') AS permission_prompts
FROM events
GROUP BY session_id, invocation_id
ORDER BY started_at DESC;

-- V3. Team lead: adoption against a roster. Per calendar day of the
--     window: the people enrolled (a table of their login names that you
--     keep, team_roster, with one user_id column), how many of them have
--     rows, their sessions and turns, and the sessions from no one on the
--     roster or with no user_id. A person with no rows is "not seen", not
--     zero use: they may not have used the agent, or their sessions may not
--     be recorded. A day with no rows at all is listed too, every enrolled
--     person not seen, and no_rows_that_day says so: absent telemetry, not
--     proof that nobody worked. Under impersonation leave
--     userIdFromCredentials off, or every row carries the service account
--     and the roster matches no one.
WITH events AS (
  SELECT *
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
    AND JSON_VALUE(attributes, '$.writer.plugin') = 'bigquery-agent-analytics-mod'
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
),
roster AS (
  SELECT DISTINCT user_id FROM `{PROJECT}.{DATASET}.team_roster`
),
days AS (
  SELECT day FROM UNNEST(GENERATE_DATE_ARRAY(DATE(@start), DATE(@end))) AS day
),
daily AS (
  SELECT
    DATE(e.timestamp) AS day,
    COUNT(*) AS rows_that_day,
    COUNT(DISTINCT IF(r.user_id IS NOT NULL, e.user_id, NULL)) AS enrolled_seen,
    COUNT(DISTINCT IF(r.user_id IS NOT NULL, e.session_id, NULL)) AS enrolled_sessions,
    COUNTIF(r.user_id IS NOT NULL AND e.event_type = 'INVOCATION_STARTING') AS enrolled_turns,
    COUNT(DISTINCT IF(r.user_id IS NULL, e.session_id, NULL)) AS other_sessions
  FROM events AS e
  LEFT JOIN roster AS r ON e.user_id = r.user_id
  GROUP BY day
)
SELECT
  d.day,
  (SELECT COUNT(*) FROM roster) AS enrolled,
  IFNULL(a.enrolled_seen, 0) AS enrolled_seen,
  (SELECT COUNT(*) FROM roster) - IFNULL(a.enrolled_seen, 0) AS enrolled_not_seen,
  IFNULL(a.enrolled_sessions, 0) AS enrolled_sessions,
  IFNULL(a.enrolled_turns, 0) AS enrolled_turns,
  IFNULL(a.other_sessions, 0) AS other_sessions,
  a.day IS NULL AS no_rows_that_day
FROM days AS d
LEFT JOIN daily AS a USING (day)
ORDER BY d.day DESC;

-- V4. Team lead: estimated cost per session and model. Tokens split the
--     way they are priced (uncached input, cache reads, cache writes,
--     output) times the rates you put in `rates`: USD per million tokens,
--     one row per model id as the model column shows it, with the date and
--     source of the rates. An estimate, not a bill: a model with no rate
--     row has no cost (NULL), not zero; nor has a session and model with a
--     response that recorded no usage (responses_without_usage counts
--     them), as its tokens are unknown. Discounts and other charges are
--     not counted.
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
  COUNTIF(r.input_tokens IS NULL OR r.output_tokens IS NULL OR r.cache_read_tokens IS NULL OR r.cache_write_tokens IS NULL) AS responses_without_usage,
  ANY_VALUE(p.rates_as_of) AS rates_as_of,
  IF(COUNTIF(r.input_tokens IS NULL OR r.output_tokens IS NULL OR r.cache_read_tokens IS NULL OR r.cache_write_tokens IS NULL) > 0, NULL,
    ROUND((SUM(r.input_tokens) * ANY_VALUE(p.input_usd)
      + SUM(r.cache_read_tokens) * ANY_VALUE(p.cache_read_usd)
      + SUM(r.cache_write_tokens) * ANY_VALUE(p.cache_write_usd)
      + SUM(r.output_tokens) * ANY_VALUE(p.output_usd)) / 1e6, 6)) AS estimated_usd
FROM responses AS r
LEFT JOIN rates AS p USING (model)
GROUP BY r.session_id, r.model
ORDER BY r.session_id, r.model;

-- V5. Team lead: the tools people use most. Per tool: the people who used
--     it, its calls, and the share of calls that failed, asked for
--     permission, and were refused (refused_pct). Each refused call is also
--     counted once by where the refusal came from: the person at the prompt
--     (rejected or aborted), a hook, a permission rule
--     (permission_decision_source config), or another source
--     (refused_other_pct: one the host did not give, which the mod records
--     as unknown, or one not named here). Those four add up to refused_pct.
--     A call that a rule blocks before the host records it leaves no row.
WITH tools AS (
  SELECT
    *,
    CASE
      WHEN JSON_VALUE(attributes, '$.permission_decision') = 'reject'
        AND JSON_VALUE(attributes, '$.permission_decision_source') IN ('user_reject', 'user_abort') THEN 'prompt'
      WHEN JSON_VALUE(attributes, '$.denied') = 'true'
        OR (JSON_VALUE(attributes, '$.permission_decision') = 'reject' AND JSON_VALUE(attributes, '$.permission_decision_source') = 'hook') THEN 'hook'
      WHEN JSON_VALUE(attributes, '$.permission_decision') = 'reject' AND JSON_VALUE(attributes, '$.permission_decision_source') = 'config' THEN 'rule'
      WHEN JSON_VALUE(attributes, '$.permission_decision') = 'reject' THEN 'other'
    END AS refusal
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
  ROUND(COUNTIF(refusal IS NOT NULL) / COUNT(*) * 100, 1) AS refused_pct,
  ROUND(COUNTIF(refusal = 'prompt') / COUNT(*) * 100, 1) AS rejected_at_prompt_pct,
  ROUND(COUNTIF(refusal = 'hook') / COUNT(*) * 100, 1) AS denied_by_hook_pct,
  ROUND(COUNTIF(refusal = 'rule') / COUNT(*) * 100, 1) AS denied_by_rule_pct,
  ROUND(COUNTIF(refusal = 'other') / COUNT(*) * 100, 1) AS refused_other_pct
FROM tools
GROUP BY tool
ORDER BY calls DESC, tool;

-- V6. Team lead: errors over time. Per day, each count beside its own
--     denominator: turns and those that ended in an error, model requests
--     (answered or failed) and the failed ones, tool calls and the failed
--     ones, and the refused tool calls (refused_tool_calls), split by where
--     the refusal came from (as in V5) into rejected_at_prompt,
--     denied_by_hook, denied_by_rule and refused_other, which add up to it.
WITH events AS (
  SELECT
    *,
    CASE
      WHEN JSON_VALUE(attributes, '$.permission_decision') = 'reject'
        AND JSON_VALUE(attributes, '$.permission_decision_source') IN ('user_reject', 'user_abort') THEN 'prompt'
      WHEN JSON_VALUE(attributes, '$.denied') = 'true'
        OR (JSON_VALUE(attributes, '$.permission_decision') = 'reject' AND JSON_VALUE(attributes, '$.permission_decision_source') = 'hook') THEN 'hook'
      WHEN JSON_VALUE(attributes, '$.permission_decision') = 'reject' AND JSON_VALUE(attributes, '$.permission_decision_source') = 'config' THEN 'rule'
      WHEN JSON_VALUE(attributes, '$.permission_decision') = 'reject' THEN 'other'
    END AS refusal
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
  COUNTIF(event_type = 'TOOL_COMPLETED' AND refusal IS NOT NULL) AS refused_tool_calls,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND refusal = 'prompt') AS rejected_at_prompt,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND refusal = 'hook') AS denied_by_hook,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND refusal = 'rule') AS denied_by_rule,
  COUNTIF(event_type = 'TOOL_COMPLETED' AND refusal = 'other') AS refused_other
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
--     An ADK model call counts once, as one row, with the largest token
--     count among its responses, in error if any of them was. ADK writes a
--     response for each streamed chunk, and with progressive streaming off
--     it writes further final responses under the agent's span; one agent
--     can also make several calls at once. So an ADK response belongs to
--     the request on its own span. A later final on the agent's span
--     belongs to the call that closed under it (its final response on its
--     own span) when exactly one could have written it: the one call that
--     closed since the last request under that span. Otherwise the rows
--     cannot tell which call wrote it, and it counts in no call's requests
--     or tokens (the call's own final carries its usage), only as a row of
--     its own; responses_ambiguous says how many. Requests are looked up
--     from a day before the window, so a call that began just before it is
--     still matched, and only rows inside the window are counted. A
--     response with no request found is counted by its span, or alone, and
--     model_requests_unmatched says how many requests were counted so.
WITH events AS (
  SELECT
    *,
    timestamp >= @start AS in_window,
    JSON_VALUE(attributes, '$.writer.plugin') IS NULL AS adk
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN TIMESTAMP_SUB(@start, INTERVAL 1 DAY) AND @end
  QUALIFY event_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY event_id ORDER BY timestamp) = 1
),
spans AS (
  SELECT
    *,
    span_id IS NOT NULL AND LOGICAL_OR(event_type = 'LLM_REQUEST') OVER (PARTITION BY adk, session_id, span_id) AS on_request_span,
    JSON_VALUE(attributes, '$.cache_type') IS NOT NULL OR JSON_VALUE(attributes, '$.finish_reason') IS NOT NULL AS final
  FROM events
),
closes AS (
  SELECT
    *,
    COUNTIF(event_type = 'LLM_RESPONSE' AND on_request_span AND final) OVER under_span AS closed_so_far,
    LAST_VALUE(IF(event_type = 'LLM_RESPONSE' AND on_request_span AND final, span_id, NULL) IGNORE NULLS) OVER under_span AS closed_call
  FROM spans
  WINDOW under_span AS (
    PARTITION BY adk, session_id, IF(on_request_span, parent_span_id, span_id)
    ORDER BY timestamp, IF(on_request_span, 0, 1)
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
linked AS (
  SELECT
    *,
    closed_so_far - IFNULL(LAST_VALUE(IF(event_type = 'LLM_REQUEST', closed_so_far, NULL) IGNORE NULLS) OVER (
      PARTITION BY adk, session_id, IF(on_request_span, parent_span_id, span_id)
      ORDER BY timestamp, IF(on_request_span, 0, 1)
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0) AS could_have_written
  FROM closes
),
tagged AS (
  SELECT
    IFNULL(JSON_VALUE(attributes, '$.writer.plugin'), 'adk (no writer)') AS producer,
    agent,
    session_id,
    event_type,
    in_window,
    status = 'ERROR' AS failed,
    COALESCE(SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens') AS INT64),
      SAFE_CAST(JSON_VALUE(attributes, '$.usage_metadata.total_token_count') AS INT64)) AS tokens,
    adk AND event_type = 'LLM_RESPONSE' AND NOT on_request_span AND span_id IS NOT NULL AND final
      AND closed_so_far > 0 AND could_have_written != 1 AS ambiguous,
    IF(adk AND event_type = 'LLM_RESPONSE',
      CASE
        WHEN on_request_span THEN CONCAT('request ', span_id)
        WHEN span_id IS NOT NULL AND final AND could_have_written = 1 THEN CONCAT('request ', closed_call)
        WHEN span_id IS NOT NULL AND final AND closed_so_far > 0 THEN NULL
        WHEN span_id IS NOT NULL THEN CONCAT('span ', span_id)
        ELSE GENERATE_UUID()
      END,
      NULL) AS call
  FROM linked
),
counted AS (
  SELECT producer, agent, session_id, IF(ambiguous, 'LLM_RESPONSE, ambiguous', event_type) AS event_type, failed,
    IF(ambiguous, NULL, tokens) AS tokens, FALSE AS unmatched, ambiguous
  FROM tagged
  WHERE in_window AND call IS NULL
  UNION ALL
  SELECT producer, agent, session_id, 'LLM_RESPONSE', LOGICAL_OR(failed), MAX(tokens), NOT STARTS_WITH(call, 'request '), FALSE
  FROM tagged
  WHERE in_window AND call IS NOT NULL
  GROUP BY producer, agent, session_id, call
)
SELECT
  producer,
  agent,
  COUNT(DISTINCT session_id) AS sessions,
  COUNTIF(event_type = 'LLM_RESPONSE') AS model_requests,
  COUNTIF(unmatched) AS model_requests_unmatched,
  COUNTIF(ambiguous) AS responses_ambiguous,
  SUM(IF(event_type = 'LLM_RESPONSE', tokens, 0)) AS tokens,
  ROUND(COUNTIF(failed) / COUNT(*) * 100, 1) AS error_row_pct
FROM counted
GROUP BY producer, agent
ORDER BY producer, agent;
