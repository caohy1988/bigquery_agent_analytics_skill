// SQL layer for the BQAA dashboard — pure string builders, no I/O.
// Kept separate from server.ts so contract tests can assert the SQL without
// touching BigQuery, and so the metric contract can eventually be shared with
// the Looker block (see upstream issue #396).

import type { Granularity, WidgetSpec } from "./types.js";

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
  "prev_overview",
  "timeseries",
  "latency",
  "tools",
  "models",
  "sessions",
  "hitl",
  "delegation",
  "agents",
] as const;
export type Section = (typeof SECTIONS)[number];

const LATENCY_EXPR = "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64)";
const LLM_LATENCY_EXPR = `IF(event_type = 'LLM_RESPONSE', ${LATENCY_EXPR}, NULL)`;

// ------------------------------------------------------------ widget contract
// The Langfuse-style widget model: measure × dimension × filters. Every entry
// is a whitelisted SQL fragment — specs select by KEY, so user/model input is
// never interpolated into SQL (filters bind as query parameters).

export const WIDGET_MEASURES: Record<string, { label: string; sql: string; unit: "count" | "pct" | "ms" | "tokens" }> = {
  events: { label: "Events", sql: "COUNT(*)", unit: "count" },
  errors: { label: "Errors", sql: "COUNTIF(status = 'ERROR')", unit: "count" },
  error_rate_pct: {
    label: "Error rate %",
    sql: "ROUND(SAFE_DIVIDE(COUNTIF(status = 'ERROR'), COUNT(*)) * 100, 2)",
    unit: "pct",
  },
  sessions: { label: "Sessions", sql: "COUNT(DISTINCT session_id)", unit: "count" },
  users: { label: "Users", sql: "COUNT(DISTINCT user_id)", unit: "count" },
  llm_calls: { label: "LLM calls", sql: "COUNTIF(event_type = 'LLM_RESPONSE')", unit: "count" },
  avg_latency_ms: { label: "Avg LLM latency", sql: `ROUND(AVG(${LLM_LATENCY_EXPR}), 0)`, unit: "ms" },
  p50_latency_ms: {
    label: "p50 LLM latency",
    sql: `APPROX_QUANTILES(${LLM_LATENCY_EXPR}, 100)[OFFSET(50)]`,
    unit: "ms",
  },
  p95_latency_ms: {
    label: "p95 LLM latency",
    sql: `APPROX_QUANTILES(${LLM_LATENCY_EXPR}, 100)[OFFSET(95)]`,
    unit: "ms",
  },
  avg_ttft_ms: {
    label: "Avg time to first token",
    sql: "ROUND(AVG(IF(event_type = 'LLM_RESPONSE', CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64), NULL)), 0)",
    unit: "ms",
  },
  prompt_tokens: {
    label: "Prompt tokens",
    sql: `SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0), 0))`,
    unit: "tokens",
  },
  completion_tokens: {
    label: "Completion tokens",
    sql: `SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0))`,
    unit: "tokens",
  },
  total_tokens: {
    label: "Total tokens",
    sql: `SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0) + COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0))`,
    unit: "tokens",
  },
  tool_calls: { label: "Tool calls", sql: "COUNTIF(event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR'))", unit: "count" },
  tool_failures: {
    label: "Tool failures",
    sql: "COUNTIF(event_type = 'TOOL_ERROR' OR (event_type = 'TOOL_COMPLETED' AND status = 'ERROR'))",
    unit: "count",
  },
};

export const WIDGET_DIMENSIONS: Record<string, { label: string; sql: string; time?: boolean }> = {
  time: { label: "Time", sql: "", time: true }, // resolved with granularity
  agent: { label: "Agent", sql: "agent" },
  model: { label: "Model", sql: MODEL_EXPR },
  tool: { label: "Tool", sql: "JSON_VALUE(content, '$.tool')" },
  user: { label: "User", sql: "user_id" },
  status: { label: "Status", sql: "status" },
  event_type: { label: "Event type", sql: "event_type" },
};

const WIDGET_FILTER_SQL: Record<string, string> = {
  agent: "agent = @f_agent",
  model: `${MODEL_EXPR} = @f_model`,
  tool: "JSON_VALUE(content, '$.tool') = @f_tool",
  status: "status = @f_status",
};

export interface BuiltWidget {
  sql: string;
  filterParams: Record<string, string>; // @f_* params (start/end/agent bind separately)
}

export function buildWidgetSql(table: string, spec: WidgetSpec): BuiltWidget {
  const measure = WIDGET_MEASURES[spec.measure];
  if (!measure) throw new Error(`Unknown measure: ${spec.measure}`);
  const dimension = WIDGET_DIMENSIONS[spec.dimension];
  if (!dimension) throw new Error(`Unknown dimension: ${spec.dimension}`);

  const where = ["timestamp BETWEEN @start AND @end"];
  const filterParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.filters ?? {})) {
    if (value == null || value === "") continue;
    const clause = WIDGET_FILTER_SQL[key];
    if (!clause) throw new Error(`Unknown filter: ${key}`);
    where.push(clause);
    filterParams[`f_${key}`] = String(value).slice(0, 200);
  }

  let dimSql: string;
  let orderBy: string;
  let limit: number;
  if (dimension.time) {
    const g = spec.granularity === "hour" ? "HOUR" : "DAY";
    dimSql = `FORMAT_TIMESTAMP('%FT%TZ', TIMESTAMP_TRUNC(timestamp, ${g}))`;
    orderBy = "dim ASC";
    limit = 2200; // ≥ 90 days of hourly buckets
  } else {
    dimSql = dimension.sql;
    orderBy = "value DESC";
    const requested = Number.isInteger(spec.limit) ? (spec.limit as number) : 20;
    limit = Math.min(100, Math.max(1, requested));
  }

  const sql = `
    SELECT ${dimSql} AS dim, ${measure.sql} AS value
    FROM ${table}
    WHERE ${where.join(" AND ")}
    GROUP BY dim
    ORDER BY ${orderBy}
    LIMIT ${limit}`;
  return { sql, filterParams };
}

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

  const overviewSql = `
    SELECT
      COUNT(*) AS total_events,
      COUNTIF(status = 'ERROR') AS errors,
      ROUND(SAFE_DIVIDE(COUNTIF(status = 'ERROR'), COUNT(*)) * 100, 2) AS error_rate_pct,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT agent) AS agents,
      COUNT(DISTINCT user_id) AS users,
      APPROX_QUANTILES(CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), 100)[OFFSET(95)] AS p95_latency_ms,
      FORMAT_TIMESTAMP('%FT%TZ', MAX(timestamp)) AS last_event_ts
    FROM ${T} WHERE ${W}`;

  return {
    overview: overviewSql,
    // identical shape over the preceding window (@start/@end bind differently)
    prev_overview: overviewSql,

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

    // HITL pairing handles both event spellings: canonical
    // HITL_*_REQUEST → HITL_*_REQUEST_COMPLETED and the ADK v1 fixture's
    // HITL_*_REQUEST → HITL_*_COMPLETED.
    hitl: `
    WITH requests AS (
      SELECT
        session_id, invocation_id, agent,
        REGEXP_EXTRACT(event_type, r'^HITL_([A-Z]+)_') AS request_type,
        timestamp AS request_time
      FROM ${T}
      WHERE event_type LIKE 'HITL_%_REQUEST' AND ${W}
    ),
    completions AS (
      SELECT
        session_id, invocation_id,
        REGEXP_EXTRACT(event_type, r'^HITL_([A-Z]+)_') AS request_type,
        timestamp AS completion_time
      FROM ${T}
      WHERE event_type LIKE 'HITL_%COMPLETED' AND ${W}
    )
    SELECT
      r.agent,
      r.request_type,
      COUNT(*) AS total_requests,
      COUNTIF(c.completion_time IS NOT NULL) AS completed,
      ROUND(AVG(TIMESTAMP_DIFF(c.completion_time, r.request_time, SECOND)), 1) AS avg_wait_sec,
      MAX(TIMESTAMP_DIFF(c.completion_time, r.request_time, SECOND)) AS max_wait_sec
    FROM requests r
    LEFT JOIN completions c
      ON r.session_id = c.session_id
      AND r.invocation_id = c.invocation_id
      AND r.request_type = c.request_type
    GROUP BY r.agent, r.request_type
    ORDER BY total_requests DESC
    LIMIT 30`,

    delegation: `
    WITH agent_tree AS (
      SELECT
        a.trace_id,
        a.agent AS child_agent,
        b.agent AS parent_agent
      FROM ${T} a
      INNER JOIN ${T} b
        ON a.parent_span_id = b.span_id
        AND a.trace_id = b.trace_id
      WHERE a.timestamp BETWEEN @start AND @end
        AND b.timestamp BETWEEN @start AND @end
        AND a.agent IS NOT NULL
        AND b.agent IS NOT NULL
        AND a.agent != b.agent
    )
    SELECT
      parent_agent, child_agent,
      COUNT(*) AS delegation_count,
      COUNT(DISTINCT trace_id) AS unique_traces
    FROM agent_tree
    GROUP BY parent_agent, child_agent
    ORDER BY delegation_count DESC
    LIMIT 30`,

    agents: `
    SELECT DISTINCT agent FROM ${T}
    WHERE timestamp BETWEEN @start AND @end AND agent IS NOT NULL
    ORDER BY agent LIMIT 100`,
  };
}

// Recent traces containing errors — lets the model (or UI) cite exact
// evidence when explaining a failure pattern.
export function buildErrorTracesSql(table: string): string {
  return `
    SELECT
      trace_id,
      FORMAT_TIMESTAMP('%FT%TZ', MAX(timestamp)) AS last_ts,
      STRING_AGG(DISTINCT agent LIMIT 5) AS agents,
      COUNTIF(status = 'ERROR') AS error_events,
      STRING_AGG(DISTINCT SUBSTR(COALESCE(error_message, event_type), 1, 160) LIMIT 3) AS sample_errors
    FROM ${table}
    WHERE timestamp BETWEEN @start AND @end
      AND trace_id IS NOT NULL
      AND trace_id IN (
        SELECT DISTINCT trace_id FROM ${table}
        WHERE status = 'ERROR' AND trace_id IS NOT NULL
          AND timestamp BETWEEN @start AND @end
      )
    GROUP BY trace_id
    ORDER BY last_ts DESC
    LIMIT @limit`;
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
