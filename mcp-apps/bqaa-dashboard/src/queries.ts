// SQL layer for the BQAA dashboard — pure string builders, no I/O.
// Kept separate from server.ts so contract tests can assert the SQL without
// touching BigQuery, and so the metric contract can eventually be shared with
// the Looker block (see upstream issue #396).

import type { Granularity } from "./types.js";

// The agent_events schema varies by producer. Canonical ADK plugins write
// `model_version` / `*_token_count` and emit LLM_ERROR / TOOL_ERROR events;
// the Claude Code tracing plugin writes `model` / `prompt_tokens` /
// `completion_tokens` and marks completed events with status='ERROR'.
// Every query reads both spellings and both failure encodings.
export const MODEL_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.model'), JSON_VALUE(attributes, '$.model_version'))";
export const PROMPT_TOK_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens'), JSON_VALUE(attributes, '$.usage_metadata.prompt_token_count'))";
export const COMPLETION_TOK_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens'), JSON_VALUE(attributes, '$.usage_metadata.candidates_token_count'))";
export const TOTAL_TOK_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.usage_metadata.total_tokens'), JSON_VALUE(attributes, '$.usage_metadata.total_token_count'))";

export const SECTIONS = [
  "overview",
  "timeseries",
  "latency",
  "tools",
  "models",
  "sessions",
  "agents",
] as const;
export type Section = (typeof SECTIONS)[number];

export interface DashboardSqlOptions {
  table: string; // fully qualified, backtick-quoted
  granularity: Granularity;
  agentFilter: boolean;
}

function whereClause(agentFilter: boolean): string {
  // The time predicate is mandatory: the table is partitioned on `timestamp`.
  return `timestamp BETWEEN @start AND @end${agentFilter ? " AND agent = @agent" : ""}`;
}

export function buildDashboardSql(opts: DashboardSqlOptions): Record<Section, string> {
  const T = opts.table;
  const G = opts.granularity === "hour" ? "HOUR" : "DAY";
  const W = whereClause(opts.agentFilter);

  return {
    overview: `
    SELECT
      COUNT(*) AS total_events,
      COUNTIF(status = 'ERROR') AS errors,
      ROUND(SAFE_DIVIDE(COUNTIF(status = 'ERROR'), COUNT(*)) * 100, 2) AS error_rate_pct,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT agent) AS agents,
      COUNT(DISTINCT user_id) AS users,
      APPROX_QUANTILES(CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), 100)[OFFSET(95)] AS p95_latency_ms
    FROM ${T} WHERE ${W}`,

    timeseries: `
    SELECT
      FORMAT_TIMESTAMP('%FT%TZ', TIMESTAMP_TRUNC(timestamp, ${G})) AS ts,
      COUNT(*) AS events,
      COUNTIF(status = 'ERROR') AS errors,
      COUNTIF(event_type = 'LLM_RESPONSE') AS llm_calls,
      COALESCE(SUM(IF(event_type = 'LLM_RESPONSE',
        COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0), 0)), 0) AS prompt_tokens,
      COALESCE(SUM(IF(event_type = 'LLM_RESPONSE',
        COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0)), 0) AS completion_tokens,
      APPROX_QUANTILES(IF(event_type = 'LLM_RESPONSE',
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL), 100)[OFFSET(50)] AS p50_latency_ms,
      APPROX_QUANTILES(IF(event_type = 'LLM_RESPONSE',
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL), 100)[OFFSET(95)] AS p95_latency_ms
    FROM ${T} WHERE ${W}
    GROUP BY ts ORDER BY ts ASC`,

    latency: `
    WITH llm_responses AS (
      SELECT
        agent,
        ${MODEL_EXPR} AS model_id,
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS total_latency_ms,
        CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64) AS ttft_ms
      FROM ${T}
      WHERE event_type = 'LLM_RESPONSE' AND ${W}
    )
    SELECT
      agent, model_id,
      COUNT(*) AS calls,
      ROUND(AVG(total_latency_ms), 0) AS avg_total_ms,
      ROUND(AVG(ttft_ms), 0) AS avg_ttft_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)] AS p50_total_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)] AS p95_total_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(99)] AS p99_total_ms
    FROM llm_responses
    GROUP BY agent, model_id
    ORDER BY p95_total_ms DESC
    LIMIT 30`,

    tools: `
    WITH tool_calls AS (
      SELECT
        JSON_VALUE(content, '$.tool') AS tool_name,
        JSON_VALUE(content, '$.tool_origin') AS tool_origin,
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS tool_latency_ms,
        (status = 'ERROR' OR event_type = 'TOOL_ERROR') AS failed
      FROM ${T}
      WHERE event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR') AND ${W}
    )
    SELECT
      tool_name, tool_origin,
      COUNT(*) AS total_calls,
      COUNTIF(failed) AS failures,
      ROUND(SAFE_DIVIDE(COUNTIF(failed), COUNT(*)) * 100, 2) AS fail_rate_pct,
      ROUND(AVG(tool_latency_ms), 0) AS avg_latency_ms,
      APPROX_QUANTILES(tool_latency_ms, 100)[OFFSET(95)] AS p95_latency_ms
    FROM tool_calls
    GROUP BY tool_name, tool_origin
    ORDER BY total_calls DESC
    LIMIT 30`,

    // Failed model calls are separate LLM_ERROR events in the canonical ADK
    // schema; the call population is attempts = responses + errors, and
    // latency/token averages come from successful responses only (their
    // columns are NULL on error rows, which AVG ignores).
    models: `
    WITH llm_events AS (
      SELECT
        ${MODEL_EXPR} AS model_id,
        (status = 'ERROR' OR event_type = 'LLM_ERROR') AS failed,
        IF(event_type = 'LLM_RESPONSE', CAST(${PROMPT_TOK_EXPR} AS INT64), NULL) AS prompt_tokens,
        IF(event_type = 'LLM_RESPONSE', CAST(${COMPLETION_TOK_EXPR} AS INT64), NULL) AS completion_tokens,
        IF(event_type = 'LLM_RESPONSE', CAST(${TOTAL_TOK_EXPR} AS INT64), NULL) AS total_tokens,
        IF(event_type = 'LLM_RESPONSE',
          CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL) AS total_latency_ms,
        IF(event_type = 'LLM_RESPONSE',
          CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64), NULL) AS ttft_ms
      FROM ${T}
      WHERE event_type IN ('LLM_RESPONSE', 'LLM_ERROR') AND ${W}
    )
    SELECT
      COALESCE(model_id, '(unknown)') AS model_id,
      COUNT(*) AS calls,
      ROUND(SAFE_DIVIDE(COUNTIF(failed), COUNT(*)) * 100, 2) AS error_rate_pct,
      ROUND(AVG(total_tokens), 0) AS avg_total_tokens,
      ROUND(AVG(prompt_tokens), 0) AS avg_prompt_tokens,
      ROUND(AVG(completion_tokens), 0) AS avg_completion_tokens,
      ROUND(AVG(total_latency_ms), 0) AS avg_latency_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)] AS p50_latency_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)] AS p95_latency_ms,
      ROUND(AVG(ttft_ms), 0) AS avg_ttft_ms
    FROM llm_events
    GROUP BY model_id
    ORDER BY calls DESC`,

    sessions: `
    WITH llm_responses AS (
      SELECT
        session_id,
        trace_id,
        ${MODEL_EXPR} AS model_id,
        COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0) AS prompt_tokens,
        COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0) AS completion_tokens
      FROM ${T}
      WHERE event_type = 'LLM_RESPONSE' AND ${W}
    )
    SELECT
      session_id, model_id,
      COUNT(*) AS llm_calls,
      SUM(prompt_tokens) AS total_prompt_tokens,
      SUM(completion_tokens) AS total_completion_tokens,
      SUM(prompt_tokens) + SUM(completion_tokens) AS total_tokens,
      ARRAY_AGG(DISTINCT trace_id IGNORE NULLS LIMIT 3) AS trace_ids
    FROM llm_responses
    GROUP BY session_id, model_id
    ORDER BY total_tokens DESC
    LIMIT 15`,

    agents: `
    SELECT DISTINCT agent FROM ${T}
    WHERE timestamp BETWEEN @start AND @end AND agent IS NOT NULL
    ORDER BY agent LIMIT 100`,
  };
}

export function buildTraceSql(table: string): string {
  return `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', timestamp) AS timestamp,
      event_type, agent, invocation_id, span_id, parent_span_id,
      JSON_VALUE(content, '$.response') AS llm_response,
      JSON_VALUE(content, '$.tool') AS tool_name,
      JSON_VALUE(content, '$.tool_origin') AS tool_origin,
      CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS latency_ms,
      status, error_message
    FROM ${table}
    WHERE trace_id = @trace_id AND timestamp BETWEEN @start AND @end
    ORDER BY timestamp ASC
    LIMIT 500`;
}
