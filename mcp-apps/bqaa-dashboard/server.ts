// BQAA Dashboard MCP App server.
// Design: GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396
//
// Tools:
//   show_agent_dashboard  — renders the interactive dashboard (ui:// resource)
//   query_agent_metrics   — same payload without UI; used by the iframe to refresh
//   get_trace             — trace reconstruction for drill-down
//
// Config (env): BQAA_PROJECT, BQAA_DATASET, BQAA_TABLE, BQAA_MOCK=1,
//               BQAA_MAX_BYTES_BILLED, PORT

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { mockDashboard, mockTrace } from "./src/mock.js";
import type { DashboardData, Granularity, TraceEvent } from "./src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  project: process.env.BQAA_PROJECT ?? "",
  dataset: process.env.BQAA_DATASET ?? "agent_analytics",
  table: process.env.BQAA_TABLE ?? "agent_events",
  mock: process.env.BQAA_MOCK === "1" || !process.env.BQAA_PROJECT,
  maxBytesBilled: process.env.BQAA_MAX_BYTES_BILLED ?? "2000000000",
  port: Number(process.env.PORT ?? 3001),
};

// ---------------------------------------------------------------- BigQuery

const PROJECT_RE = /^[A-Za-z0-9_.:-]+$/;
const ID_RE = /^[A-Za-z0-9_]+$/;

function tableRef(): string {
  if (!PROJECT_RE.test(CONFIG.project)) throw new Error(`Invalid BQAA_PROJECT: ${CONFIG.project}`);
  if (!ID_RE.test(CONFIG.dataset)) throw new Error(`Invalid BQAA_DATASET: ${CONFIG.dataset}`);
  if (!ID_RE.test(CONFIG.table)) throw new Error(`Invalid BQAA_TABLE: ${CONFIG.table}`);
  return "`" + `${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table}` + "`";
}

let bqClient: import("@google-cloud/bigquery").BigQuery | null = null;

async function runQuery(sql: string, params: Record<string, unknown>): Promise<any[]> {
  if (!bqClient) {
    const { BigQuery } = await import("@google-cloud/bigquery");
    bqClient = new BigQuery({ projectId: CONFIG.project });
  }
  const [rows] = await bqClient.query({
    query: sql,
    params,
    maximumBytesBilled: CONFIG.maxBytesBilled,
  });
  return rows;
}

function whereClause(agent?: string | null): string {
  // Time predicate is mandatory: the table is partitioned on `timestamp`.
  let w = "timestamp BETWEEN @start AND @end";
  if (agent) w += " AND agent = @agent";
  return w;
}

async function bigQueryDashboard(
  start: Date,
  end: Date,
  granularity: Granularity,
  agent?: string | null,
): Promise<DashboardData> {
  const T = tableRef();
  const G = granularity === "hour" ? "HOUR" : "DAY";
  const W = whereClause(agent);
  const params: Record<string, unknown> = { start: start.toISOString(), end: end.toISOString() };
  if (agent) params.agent = agent;

  const overviewSql = `
    SELECT
      COUNT(*) AS total_events,
      COUNTIF(status = 'ERROR') AS errors,
      ROUND(SAFE_DIVIDE(COUNTIF(status = 'ERROR'), COUNT(*)) * 100, 2) AS error_rate_pct,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT agent) AS agents,
      COUNT(DISTINCT user_id) AS users,
      APPROX_QUANTILES(CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), 100)[OFFSET(95)] AS p95_latency_ms
    FROM ${T} WHERE ${W}`;

  const timeseriesSql = `
    SELECT
      FORMAT_TIMESTAMP('%FT%TZ', TIMESTAMP_TRUNC(timestamp, ${G})) AS ts,
      COUNT(*) AS events,
      COUNTIF(status = 'ERROR') AS errors,
      COUNTIF(event_type = 'LLM_RESPONSE') AS llm_calls,
      COALESCE(SUM(IF(event_type = 'LLM_RESPONSE',
        COALESCE(CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens') AS INT64), 0), 0)), 0) AS prompt_tokens,
      COALESCE(SUM(IF(event_type = 'LLM_RESPONSE',
        COALESCE(CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens') AS INT64), 0), 0)), 0) AS completion_tokens,
      APPROX_QUANTILES(IF(event_type = 'LLM_RESPONSE',
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL), 100)[OFFSET(50)] AS p50_latency_ms,
      APPROX_QUANTILES(IF(event_type = 'LLM_RESPONSE',
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL), 100)[OFFSET(95)] AS p95_latency_ms
    FROM ${T} WHERE ${W}
    GROUP BY ts ORDER BY ts ASC`;

  const latencySql = `
    WITH llm_responses AS (
      SELECT
        agent,
        JSON_VALUE(attributes, '$.model') AS model_id,
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
    LIMIT 30`;

  const toolsSql = `
    WITH tool_calls AS (
      SELECT
        JSON_VALUE(content, '$.tool') AS tool_name,
        JSON_VALUE(content, '$.tool_origin') AS tool_origin,
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS tool_latency_ms,
        status
      FROM ${T}
      WHERE event_type = 'TOOL_COMPLETED' AND ${W}
    )
    SELECT
      tool_name, tool_origin,
      COUNT(*) AS total_calls,
      COUNTIF(status = 'ERROR') AS failures,
      ROUND(SAFE_DIVIDE(COUNTIF(status = 'ERROR'), COUNT(*)) * 100, 2) AS fail_rate_pct,
      ROUND(AVG(tool_latency_ms), 0) AS avg_latency_ms,
      APPROX_QUANTILES(tool_latency_ms, 100)[OFFSET(95)] AS p95_latency_ms
    FROM tool_calls
    GROUP BY tool_name, tool_origin
    ORDER BY total_calls DESC
    LIMIT 30`;

  const modelsSql = `
    WITH llm_responses AS (
      SELECT
        JSON_VALUE(attributes, '$.model') AS model_id,
        CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens') AS INT64) AS prompt_tokens,
        CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens') AS INT64) AS completion_tokens,
        CAST(JSON_VALUE(attributes, '$.usage_metadata.total_tokens') AS INT64) AS total_tokens,
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS total_latency_ms,
        CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64) AS ttft_ms,
        status
      FROM ${T}
      WHERE event_type = 'LLM_RESPONSE' AND ${W}
    )
    SELECT
      model_id,
      COUNT(*) AS calls,
      ROUND(SAFE_DIVIDE(COUNTIF(status = 'ERROR'), COUNT(*)) * 100, 2) AS error_rate_pct,
      ROUND(AVG(total_tokens), 0) AS avg_total_tokens,
      ROUND(AVG(prompt_tokens), 0) AS avg_prompt_tokens,
      ROUND(AVG(completion_tokens), 0) AS avg_completion_tokens,
      ROUND(AVG(total_latency_ms), 0) AS avg_latency_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)] AS p50_latency_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)] AS p95_latency_ms,
      ROUND(AVG(ttft_ms), 0) AS avg_ttft_ms
    FROM llm_responses
    GROUP BY model_id
    ORDER BY calls DESC`;

  const sessionsSql = `
    WITH llm_responses AS (
      SELECT
        session_id,
        JSON_VALUE(attributes, '$.model') AS model_id,
        COALESCE(CAST(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens') AS INT64), 0) AS prompt_tokens,
        COALESCE(CAST(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens') AS INT64), 0) AS completion_tokens
      FROM ${T}
      WHERE event_type = 'LLM_RESPONSE' AND ${W}
    )
    SELECT
      session_id, model_id,
      COUNT(*) AS llm_calls,
      SUM(prompt_tokens) AS total_prompt_tokens,
      SUM(completion_tokens) AS total_completion_tokens,
      SUM(prompt_tokens) + SUM(completion_tokens) AS total_tokens
    FROM llm_responses
    GROUP BY session_id, model_id
    ORDER BY total_tokens DESC
    LIMIT 15`;

  const agentsSql = `
    SELECT DISTINCT agent FROM ${T}
    WHERE timestamp BETWEEN @start AND @end AND agent IS NOT NULL
    ORDER BY agent LIMIT 100`;

  const [overviewRows, timeseries, latencyByAgent, toolStats, modelComparison, topSessions, agentRows] =
    await Promise.all([
      runQuery(overviewSql, params),
      runQuery(timeseriesSql, params),
      runQuery(latencySql, params),
      runQuery(toolsSql, params),
      runQuery(modelsSql, params),
      runQuery(sessionsSql, params),
      runQuery(agentsSql, { start: params.start, end: params.end }),
    ]);

  return {
    meta: {
      source: `${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table}`,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
      agent: agent ?? null,
    },
    overview: overviewRows[0],
    timeseries,
    latencyByAgent,
    toolStats,
    modelComparison,
    topSessions,
    agentsList: agentRows.map((r: any) => r.agent),
  };
}

async function loadDashboard(timeRangeHours: number, agent?: string | null): Promise<DashboardData> {
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const granularity: Granularity = timeRangeHours <= 72 ? "hour" : "day";
  if (CONFIG.mock) return mockDashboard(start, end, granularity, agent);
  return bigQueryDashboard(start, end, granularity, agent);
}

async function loadTrace(traceId: string, timeRangeHours: number): Promise<TraceEvent[]> {
  if (CONFIG.mock) return mockTrace(traceId);
  const T = tableRef();
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  return runQuery(
    `SELECT
       FORMAT_TIMESTAMP('%FT%E6SZ', timestamp) AS timestamp,
       event_type, agent, invocation_id, span_id, parent_span_id,
       JSON_VALUE(content, '$.response') AS llm_response,
       JSON_VALUE(content, '$.tool') AS tool_name,
       JSON_VALUE(content, '$.tool_origin') AS tool_origin,
       CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS latency_ms,
       status, error_message
     FROM ${T}
     WHERE trace_id = @trace_id AND timestamp BETWEEN @start AND @end
     ORDER BY timestamp ASC
     LIMIT 500`,
    { trace_id: traceId, start: start.toISOString(), end: end.toISOString() },
  );
}

// ---------------------------------------------------------------- summaries

function summarize(d: DashboardData): string {
  const o = d.overview;
  const hours = Math.round((Date.parse(d.meta.end) - Date.parse(d.meta.start)) / 3_600_000);
  const topModel = d.modelComparison[0];
  const worstTool = [...d.toolStats].sort((a, b) => b.fail_rate_pct - a.fail_rate_pct)[0];
  const lines = [
    `Agent analytics, last ${hours}h (source: ${d.meta.source}${d.meta.agent ? `, agent=${d.meta.agent}` : ""}):`,
    `- ${o.total_events.toLocaleString()} events, ${o.sessions.toLocaleString()} sessions, ${o.users.toLocaleString()} users, ${o.agents} agents`,
    `- error rate ${o.error_rate_pct}%, p95 event latency ${o.p95_latency_ms ?? "n/a"} ms`,
  ];
  if (topModel) lines.push(`- busiest model: ${topModel.model_id} (${topModel.calls.toLocaleString()} calls, p95 ${topModel.p95_latency_ms ?? "n/a"} ms)`);
  if (worstTool) lines.push(`- highest tool failure rate: ${worstTool.tool_name} at ${worstTool.fail_rate_pct}% of ${worstTool.total_calls.toLocaleString()} calls`);
  lines.push("The interactive dashboard has been rendered for the user.");
  return lines.join("\n");
}

// ---------------------------------------------------------------- MCP server

const server = new McpServer({ name: "BigQuery Agent Analytics Dashboard", version: "0.1.0" });

const resourceUri = "ui://bqaa/dashboard.html";

const metricArgs = {
  time_range_hours: z
    .number()
    .int()
    .min(1)
    .max(2160)
    .default(168)
    .describe("Lookback window in hours (default 168 = 7 days, max 2160 = 90 days)"),
  agent: z.string().max(200).optional().describe("Optional: restrict to a single agent name"),
};

async function metricsHandler(args: { time_range_hours?: number; agent?: string }) {
  const data = await loadDashboard(args.time_range_hours ?? 168, args.agent ?? null);
  return {
    content: [{ type: "text" as const, text: summarize(data) }],
    structuredContent: { data } as any,
  };
}

registerAppTool(
  server,
  "show_agent_dashboard",
  {
    title: "Agent Analytics Dashboard",
    description:
      "Render an interactive dashboard (overview, latency, tokens, tools) over the BigQuery Agent Analytics agent_events table. Use when the user wants to see, explore, or monitor agent metrics visually.",
    inputSchema: metricArgs,
    outputSchema: { data: z.unknown() },
    _meta: { ui: { resourceUri } },
  },
  metricsHandler,
);

server.registerTool(
  "query_agent_metrics",
  {
    title: "Query agent metrics",
    description:
      "Return the aggregated agent-analytics payload (overview, timeseries, latency by agent, token usage, tool stats) as structured data without rendering UI. Used by the dashboard for refresh/filtering; also useful for text answers.",
    inputSchema: metricArgs,
    outputSchema: { data: z.unknown() },
  },
  metricsHandler,
);

server.registerTool(
  "get_trace",
  {
    title: "Get trace",
    description: "Reconstruct a single trace (ordered agent_events) by trace_id for drill-down debugging.",
    inputSchema: {
      trace_id: z.string().min(4).max(64).describe("OpenTelemetry trace id"),
      time_range_hours: z.number().int().min(1).max(2160).default(168),
    },
    outputSchema: { data: z.unknown() },
  },
  async (args) => {
    const events = await loadTrace(args.trace_id, args.time_range_hours ?? 168);
    return {
      content: [
        {
          type: "text" as const,
          text: `Trace ${args.trace_id}: ${events.length} events, ${events.filter((e) => e.status === "ERROR").length} errors.`,
        },
      ],
      structuredContent: { data: events } as any,
    };
  },
);

registerAppResource(server, resourceUri, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
  const html = await fs.readFile(path.join(__dirname, "dist", "mcp-app.html"), "utf-8");
  return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
});

// ---------------------------------------------------------------- transport

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Browser-shareable view: serve the dashboard UI at the root, and let its
// standalone mode pull live data over plain HTTP instead of the MCP bridge.
app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(path.join(__dirname, "dist", "mcp-app.html"), "utf-8");
    res.type("html").send(html);
  } catch {
    res.status(500).send("UI bundle missing — run `npm run build` first.");
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const hours = Math.min(2160, Math.max(1, Math.trunc(Number(req.query.time_range_hours)) || 168));
    const agentRaw = typeof req.query.agent === "string" ? req.query.agent.slice(0, 200) : "";
    const data = await loadDashboard(hours, agentRaw || null);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(CONFIG.port, () => {
  console.log(
    `BQAA dashboard MCP server on http://localhost:${CONFIG.port}/mcp ` +
      (CONFIG.mock ? "(mock data — set BQAA_PROJECT/BQAA_DATASET/BQAA_TABLE for BigQuery)" : `(BigQuery: ${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table})`),
  );
});
