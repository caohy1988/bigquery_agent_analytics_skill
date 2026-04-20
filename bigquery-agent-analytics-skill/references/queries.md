# Ready-to-Run Queries

All queries use `{PROJECT}`, `{DATASET}`, `{TABLE}` placeholders which are
auto-replaced by `scripts/run_bq.py`. Always dry-run before executing.

---

## Survey (Step 1 — use for every analysis)

```sql
SELECT
  COUNT(*)                                                        AS total_events,
  COUNTIF(status = 'ERROR')                                       AS errors,
  ROUND(COUNTIF(status = 'ERROR') / COUNT(*) * 100, 2)            AS error_rate_pct,
  COUNT(DISTINCT session_id)                                      AS sessions,
  COUNT(DISTINCT agent)                                           AS agents,
  COUNT(DISTINCT user_id)                                         AS users,
  APPROX_QUANTILES(
    CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), 100
  )[OFFSET(95)]                                                   AS p95_latency_ms
FROM `{PROJECT}.{DATASET}.{TABLE}`
WHERE timestamp BETWEEN @start AND @end
```

---

## Trace Reconstruction

**Partition safety:** `trace_id` alone is not enough — without a
`timestamp` predicate the query scans every partition in the table.
Always pass an `@start`/`@end` window that brackets when the trace
ran (a ±1 day window around the incident is usually enough).

```sql
SELECT
  timestamp, event_type, agent, invocation_id, span_id, parent_span_id,
  JSON_VALUE(content, '$.response')    AS llm_response,
  JSON_VALUE(content, '$.tool')        AS tool_name,
  JSON_VALUE(content, '$.tool_origin') AS tool_origin,
  CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS latency_ms,
  status, error_message
FROM `{PROJECT}.{DATASET}.{TABLE}`
WHERE trace_id = @trace_id
  AND timestamp BETWEEN @start AND @end
ORDER BY timestamp ASC
```

---

## Latency Analysis

```sql
WITH llm_responses AS (
  SELECT
    agent,
    JSON_VALUE(attributes, '$.model')                                       AS model_id,
    CAST(JSON_VALUE(latency_ms, '$.total_ms')              AS FLOAT64)      AS total_latency_ms,
    CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64)     AS ttft_ms
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
)
SELECT
  agent, model_id,
  COUNT(*)                                                       AS calls,
  ROUND(AVG(total_latency_ms), 0)                                AS avg_total_ms,
  ROUND(AVG(ttft_ms), 0)                                         AS avg_ttft_ms,
  ROUND(AVG(total_latency_ms) - AVG(ttft_ms), 0)                 AS avg_generation_ms,
  APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)]            AS p50_total_ms,
  APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)]            AS p95_total_ms,
  APPROX_QUANTILES(ttft_ms, 100)[OFFSET(95)]                     AS p95_ttft_ms
FROM llm_responses
GROUP BY agent, model_id
ORDER BY avg_total_ms DESC
```

---

## Token Usage Trends

```sql
WITH llm_responses AS (
  SELECT
    DATE(timestamp)                                                          AS dt,
    JSON_VALUE(attributes, '$.model')                                        AS model_id,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens')     AS INT64) AS prompt_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens') AS INT64) AS completion_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens')      AS INT64) AS total_tokens
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
)
SELECT
  dt, model_id,
  COUNT(*)                         AS llm_calls,
  SUM(prompt_tokens)               AS total_prompt_tokens,
  SUM(completion_tokens)           AS total_completion_tokens,
  SUM(total_tokens)                AS total_tokens,
  ROUND(AVG(prompt_tokens), 0)     AS avg_prompt_tokens,
  ROUND(AVG(completion_tokens), 0) AS avg_completion_tokens
FROM llm_responses
GROUP BY dt, model_id
ORDER BY dt ASC, model_id
```

---

## Tool Failure Rates

```sql
WITH tool_calls AS (
  SELECT
    JSON_VALUE(content, '$.tool')        AS tool_name,
    JSON_VALUE(content, '$.tool_origin') AS tool_origin,
    CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS tool_latency_ms,
    status
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'TOOL_COMPLETED'
    AND timestamp BETWEEN @start AND @end
)
SELECT
  tool_name, tool_origin,
  COUNT(*)                                                     AS total_calls,
  COUNTIF(status = 'ERROR')                                    AS failures,
  ROUND(COUNTIF(status = 'ERROR') / COUNT(*) * 100, 2)         AS fail_rate_pct,
  ROUND(AVG(tool_latency_ms), 0)                                AS avg_latency_ms,
  APPROX_QUANTILES(tool_latency_ms, 100)[OFFSET(95)]            AS p95_latency_ms
FROM tool_calls
GROUP BY tool_name, tool_origin
ORDER BY failures DESC
```

---

## Agent Delegation Map

Uses `INNER JOIN` (not `LEFT JOIN` like the base `agent_tree` CTE):
we only care about pairs where a parent span actually exists, so
dropping unparented root events is desirable here. Use `LEFT JOIN`
(as in `references/ctes.md`) when you also need to see top-level
events with no parent.

```sql
WITH agent_tree AS (
  SELECT
    a.trace_id,
    a.agent   AS child_agent,
    b.agent   AS parent_agent
  FROM `{PROJECT}.{DATASET}.{TABLE}` a
  INNER JOIN `{PROJECT}.{DATASET}.{TABLE}` b
    ON  a.parent_span_id = b.span_id
    AND a.trace_id       = b.trace_id
  WHERE a.timestamp BETWEEN @start AND @end
    AND b.timestamp BETWEEN @start AND @end
    AND a.agent IS NOT NULL
    AND b.agent IS NOT NULL
    AND a.agent != b.agent
)
SELECT
  parent_agent, child_agent,
  COUNT(*)               AS delegation_count,
  COUNT(DISTINCT trace_id) AS unique_traces
FROM agent_tree
GROUP BY parent_agent, child_agent
ORDER BY delegation_count DESC
```

---

## HITL Bottlenecks

```sql
WITH hitl_requests AS (
  SELECT
    session_id, agent, invocation_id, trace_id, event_type,
    timestamp AS request_time
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type IN (
    'HITL_CREDENTIAL_REQUEST', 'HITL_CONFIRMATION_REQUEST', 'HITL_INPUT_REQUEST'
  )
  AND timestamp BETWEEN @start AND @end
),
hitl_completions AS (
  SELECT
    session_id, invocation_id, event_type,
    timestamp AS completion_time
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type IN (
    'HITL_CREDENTIAL_REQUEST_COMPLETED',
    'HITL_CONFIRMATION_REQUEST_COMPLETED',
    'HITL_INPUT_REQUEST_COMPLETED'
  )
  AND timestamp BETWEEN @start AND @end
)
SELECT
  r.agent,
  r.event_type                                                         AS request_type,
  COUNT(*)                                                             AS total_requests,
  COUNTIF(c.completion_time IS NOT NULL)                               AS completed,
  ROUND(AVG(TIMESTAMP_DIFF(c.completion_time, r.request_time, SECOND)), 1) AS avg_wait_sec,
  MAX(TIMESTAMP_DIFF(c.completion_time, r.request_time, SECOND))       AS max_wait_sec
FROM hitl_requests r
LEFT JOIN hitl_completions c
  ON  r.session_id    = c.session_id
  AND r.invocation_id = c.invocation_id
GROUP BY r.agent, r.event_type
ORDER BY avg_wait_sec DESC
```

---

## Model Comparison

```sql
WITH llm_responses AS (
  SELECT
    JSON_VALUE(attributes, '$.model')                                        AS model_id,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens')     AS INT64)   AS prompt_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens') AS INT64)   AS completion_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens')      AS INT64)   AS total_tokens,
    CAST(JSON_VALUE(latency_ms, '$.total_ms')                         AS FLOAT64) AS total_latency_ms,
    CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms')           AS FLOAT64) AS ttft_ms,
    status
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
)
SELECT
  model_id,
  COUNT(*)                                                       AS calls,
  ROUND(COUNTIF(status = 'ERROR') / COUNT(*) * 100, 2)           AS error_rate_pct,
  ROUND(AVG(total_tokens), 0)                                    AS avg_total_tokens,
  ROUND(AVG(prompt_tokens), 0)                                   AS avg_prompt_tokens,
  ROUND(AVG(completion_tokens), 0)                               AS avg_completion_tokens,
  ROUND(AVG(total_latency_ms), 0)                                AS avg_latency_ms,
  APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)]            AS p50_latency_ms,
  APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)]            AS p95_latency_ms,
  ROUND(AVG(ttft_ms), 0)                                         AS avg_ttft_ms
FROM llm_responses
GROUP BY model_id
ORDER BY avg_latency_ms DESC
```

---

## Session Token Usage (for cost estimation)

Outputs raw prompt/completion token counts grouped by `session_id` and
`model_id`. **Cost projection is intentionally left to the caller** —
per-token prices vary by model, region, context-length tier, and
contract, so embedding a fixed rate here produces misleading numbers
in multi-model environments.

To estimate cost, multiply the token columns by the current published
prices for each `model_id` (e.g. from your vendor's pricing page).

```sql
WITH llm_responses AS (
  SELECT
    session_id,
    JSON_VALUE(attributes, '$.model')                                        AS model_id,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens')     AS INT64) AS prompt_tokens,
    CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens') AS INT64) AS completion_tokens
  FROM `{PROJECT}.{DATASET}.{TABLE}`
  WHERE event_type = 'LLM_RESPONSE'
    AND timestamp BETWEEN @start AND @end
)
SELECT
  session_id,
  model_id,
  COUNT(*)                    AS llm_calls,
  SUM(prompt_tokens)          AS total_prompt_tokens,
  SUM(completion_tokens)      AS total_completion_tokens,
  SUM(prompt_tokens) + SUM(completion_tokens) AS total_tokens
FROM llm_responses
GROUP BY session_id, model_id
ORDER BY total_tokens DESC
```
