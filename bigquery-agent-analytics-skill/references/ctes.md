# Base CTEs

Never write raw `JSON_VALUE()` or `JSON_EXTRACT()` from scratch. Always start
queries with one of these CTEs. Compose by stacking multiple CTEs with
comma-separated WITH clauses.

**Default CTE:** Use `llm_responses` unless the question is specifically about
tools (`tool_calls`), errors (`errors`), sessions (`sessions`), or
delegation (`agent_tree`).

---

## llm_responses

Use for: token usage, latency, model analysis, cost estimation.

```sql
WITH llm_responses AS (
  SELECT
    timestamp,
    agent,
    session_id,
    invocation_id,
    user_id,
    trace_id,
    span_id,
    parent_span_id,
    JSON_VALUE(content, '$.response')                                       AS response_text,
    JSON_VALUE(attributes, '$.model')                                       AS model_id,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens')      AS INT64)   AS prompt_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens')  AS INT64)   AS completion_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens')       AS INT64)   AS total_tokens,
    CAST(JSON_VALUE(latency_ms, '$.total_ms')                          AS FLOAT64) AS total_latency_ms,
    CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms')            AS FLOAT64) AS ttft_ms,
    status,
    error_message
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
)
```

---

## tool_calls

Use for: tool performance, failure rates, tool origin analysis.

```sql
WITH tool_calls AS (
  SELECT
    timestamp,
    agent,
    session_id,
    invocation_id,
    user_id,
    trace_id,
    span_id,
    JSON_VALUE(content, '$.tool')                          AS tool_name,
    JSON_VALUE(content, '$.tool_origin')                   AS tool_origin,
    JSON_VALUE(content, '$.result')                        AS tool_result,
    CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64)  AS tool_latency_ms,
    status,
    error_message
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'TOOL_COMPLETED'
    AND timestamp BETWEEN @start AND @end
)
```

---

## errors

Use for: error investigation, failure root cause analysis.

```sql
WITH errors AS (
  SELECT
    timestamp,
    event_type,
    agent,
    session_id,
    invocation_id,
    user_id,
    trace_id,
    span_id,
    content,
    attributes,
    latency_ms,
    error_message
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE status = 'ERROR'
    AND timestamp BETWEEN @start AND @end
)
```

---

## sessions

Use for: session-level rollups, duration analysis, cost estimation.

```sql
WITH sessions AS (
  SELECT
    session_id,
    user_id,
    MIN(timestamp)                                              AS session_start,
    MAX(timestamp)                                              AS session_end,
    TIMESTAMP_DIFF(MAX(timestamp), MIN(timestamp), SECOND)      AS duration_sec,
    COUNT(*)                                                    AS total_events,
    COUNTIF(event_type = 'LLM_RESPONSE')                        AS llm_calls,
    COUNTIF(event_type = 'TOOL_COMPLETED')                      AS tool_calls,
    COUNTIF(status = 'ERROR')                                   AS error_count,
    COUNT(DISTINCT agent)                                       AS agents_involved,
    COUNT(DISTINCT invocation_id)                                AS invocation_count
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE timestamp BETWEEN @start AND @end
  GROUP BY session_id, user_id
)
```

---

## agent_tree

Use for: multi-agent delegation flows, detecting loops.

**Reminder:** This CTE joins on BOTH `span_id` AND `trace_id`. Never omit `trace_id`.

**Why `LEFT JOIN`:** the base CTE keeps root events (no parent span)
so callers can reason about the full tree including entry points.
When you only want true parent→child pairs (e.g. a delegation map),
switch to `INNER JOIN` — see `queries.md → Agent Delegation Map`.

```sql
WITH agent_tree AS (
  SELECT
    a.trace_id,
    a.span_id           AS child_span,
    a.agent              AS child_agent,
    a.event_type         AS child_event,
    a.timestamp          AS child_timestamp,
    b.span_id            AS parent_span,
    b.agent              AS parent_agent,
    b.event_type         AS parent_event
  FROM `{PROJECT}.{DATASET}.{TABLE}` a
  LEFT JOIN `{PROJECT}.{DATASET}.{TABLE}` b
    ON  a.parent_span_id = b.span_id
    AND a.trace_id       = b.trace_id
    AND b.timestamp BETWEEN @start AND @end
  WHERE a.timestamp BETWEEN @start AND @end
)
```
