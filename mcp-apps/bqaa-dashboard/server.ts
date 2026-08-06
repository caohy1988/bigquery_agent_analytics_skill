// BQAA Dashboard MCP App server.
// Design: GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396
//
// Tools:
//   show_agent_dashboard  — renders the interactive dashboard (ui:// resource)
//   query_agent_metrics   — same payload without UI; used by the iframe to refresh
//   get_trace             — trace reconstruction for drill-down
//
// HTTP surface: GET / (dashboard webapp), GET /api/dashboard, GET /api/trace,
// POST /mcp, GET /healthz.
//
// Config (env): BQAA_PROJECT, BQAA_DATASET, BQAA_TABLE, BQAA_MOCK=1,
// BQAA_MAX_BYTES_BILLED (per refresh), BQAA_DEFAULT_HOURS, BQAA_AUTH_TOKEN,
// BQAA_ALLOWED_ORIGINS, PORT. See README for details.

import { existsSync } from "node:fs";
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
import { askConversational } from "./src/ca.js";
import { mockAsk, mockDashboard, mockErrorTraces, mockTrace, mockWidget } from "./src/mock.js";
import {
  BQ_MIN_BYTES_PER_QUERY,
  buildDashboardSql,
  buildErrorTracesSql,
  buildTraceSql,
  buildWidgetSql,
  SECTIONS,
  splitBudget,
  WIDGET_DIMENSIONS,
  WIDGET_MEASURES,
} from "./src/queries.js";
import type {
  AskExchange,
  AskResult,
  DashboardData,
  ErrorTraceRow,
  Granularity,
  OverviewStats,
  TraceEvent,
  TraceResult,
  WidgetResult,
  WidgetSpec,
} from "./src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    console.error(`Invalid ${name}=${JSON.stringify(raw)} — expected an integer in [${min}, ${max}]`);
    process.exit(1);
  }
  return v;
}

const MAX_HOURS = 2160; // 90 days

const CONFIG = {
  project: process.env.BQAA_PROJECT ?? "",
  dataset: process.env.BQAA_DATASET ?? "agent_analytics",
  table: process.env.BQAA_TABLE ?? "agent_events",
  mock: process.env.BQAA_MOCK === "1" || !process.env.BQAA_PROJECT,
  // Budget for ONE dashboard refresh (split across its queries), in bytes.
  // Minimum = SECTIONS x BigQuery's 10 MiB floor for maximumBytesBilled —
  // anything smaller would make every panel query invalid.
  refreshBytesBudget: intEnv(
    "BQAA_MAX_BYTES_BILLED",
    2_000_000_000,
    SECTIONS.length * BQ_MIN_BYTES_PER_QUERY,
    1_000_000_000_000,
  ),
  // Application deadline for a single BigQuery query (job is cancelled on expiry).
  queryTimeoutMs: intEnv("BQAA_QUERY_TIMEOUT_MS", 90_000, 500, 600_000),
  port: intEnv("PORT", 3001, 0, 65535),
  defaultHours: intEnv("BQAA_DEFAULT_HOURS", 168, 1, MAX_HOURS),
  authToken: process.env.BQAA_AUTH_TOKEN ?? "",
  // Comma-separated Origin allowlist, or "*". Unset ⇒ same-origin only:
  // no CORS headers, and cross-origin requests bearing an Origin are refused.
  allowedOrigins: (process.env.BQAA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

const PROJECT_RE = /^[A-Za-z0-9_.:-]+$/;
const ID_RE = /^[A-Za-z0-9_]+$/;
const TRACE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function tableRef(): string {
  if (!PROJECT_RE.test(CONFIG.project)) throw new Error(`Invalid BQAA_PROJECT: ${CONFIG.project}`);
  if (!ID_RE.test(CONFIG.dataset)) throw new Error(`Invalid BQAA_DATASET: ${CONFIG.dataset}`);
  if (!ID_RE.test(CONFIG.table)) throw new Error(`Invalid BQAA_TABLE: ${CONFIG.table}`);
  return "`" + `${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table}` + "`";
}
if (!CONFIG.mock) tableRef(); // fail fast on invalid identifiers

function uiBundlePath(): string {
  // src layout: <root>/dist/mcp-app.html — container layout: <dist>/mcp-app.html
  for (const p of [path.join(__dirname, "dist", "mcp-app.html"), path.join(__dirname, "mcp-app.html")]) {
    if (existsSync(p)) return p;
  }
  return path.join(__dirname, "dist", "mcp-app.html");
}

// ---------------------------------------------------------------- BigQuery

let bqClient: import("@google-cloud/bigquery").BigQuery | null = null;

// Global cap on simultaneous BigQuery jobs: past it, requests fail fast
// instead of piling unbounded work onto the project.
const MAX_CONCURRENT_JOBS = 20;
let inflightJobs = 0;

async function withJobSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (inflightJobs >= MAX_CONCURRENT_JOBS) {
    throw new Error("Server busy: too many concurrent BigQuery jobs — retry shortly");
  }
  inflightJobs++;
  try {
    return await fn();
  } finally {
    inflightJobs--;
  }
}

interface QueryResult {
  rows: any[];
  bytes: number;
}

async function runQuery(
  sql: string,
  params: Record<string, unknown>,
  maxBytes: number,
): Promise<QueryResult> {
  return withJobSlot(async () => {
    const client = await bigQueryClient();
    const [job] = await client.createQueryJob({
      query: sql,
      params,
      maximumBytesBilled: String(maxBytes),
    });
    try {
      // #9: an application deadline so a stalled job cannot hold its slot
      const [rows] = await withDeadline<[any[]]>(job.getQueryResults(), CONFIG.queryTimeoutMs);
      const [meta] = await job.getMetadata();
      return { rows, bytes: Number(meta?.statistics?.totalBytesProcessed ?? 0) };
    } catch (e) {
      if (e instanceof Error && e.message.includes("timed out")) {
        void (job as any).cancel?.().catch(() => {});
      }
      throw e;
    }
  });
}

async function bigQueryClient(): Promise<any> {
  if (!bqClient) {
    if (process.env.BQAA_FAKE_BQ) {
      // test seam: production branches run against a controllable fake
      const { makeFakeBigQuery } = await import("./src/fakebq.js");
      bqClient = makeFakeBigQuery(process.env.BQAA_FAKE_BQ) as any;
    } else {
      const { BigQuery } = await import("@google-cloud/bigquery");
      bqClient = new BigQuery({ projectId: CONFIG.project });
    }
  }
  return bqClient;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`BigQuery query timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Estimate a query's scan size without running it (BigQuery dry run).
async function dryRunQuery(sql: string, params: Record<string, unknown>): Promise<number> {
  const client = await bigQueryClient();
  const [job] = await client.createQueryJob({ query: sql, params, dryRun: true });
  return Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
}

const EMPTY_OVERVIEW: OverviewStats = {
  total_events: null,
  errors: null,
  error_rate_pct: null,
  sessions: null,
  agents: null,
  users: null,
  p95_latency_ms: null,
};

async function bigQueryDashboard(
  start: Date,
  end: Date,
  granularity: Granularity,
  agent?: string | null,
): Promise<DashboardData> {
  const sql = buildDashboardSql({ table: tableRef(), granularity, agentFilter: !!agent });
  const params: Record<string, unknown> = { start: start.toISOString(), end: end.toISOString() };
  if (agent) params.agent = agent;
  // preceding window of equal length, for period-over-period deltas
  const prevParams: Record<string, unknown> = {
    start: new Date(start.getTime() - (end.getTime() - start.getTime())).toISOString(),
    end: start.toISOString(),
    ...(agent ? { agent } : {}),
  };
  const paramsFor = (s: (typeof SECTIONS)[number]): Record<string, unknown> =>
    s === "prev_overview" ? prevParams : s === "agents" || s === "delegation" ? { start: params.start, end: params.end } : params;

  // The refresh budget is split exactly across the panel queries so one
  // dashboard load can never authorize more than BQAA_MAX_BYTES_BILLED total.
  const perQueryBytes = splitBudget(CONFIG.refreshBytesBudget, SECTIONS.length);

  const settled = await Promise.allSettled(SECTIONS.map((s) => runQuery(sql[s], paramsFor(s), perQueryBytes)));

  // One failed panel must not blank the dashboard: keep healthy sections,
  // report the failed ones (truthfully) in meta.section_errors.
  const sectionErrors: Record<string, string> = {};
  let bytes = 0;
  const rowsOf = (i: number): any[] | null => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      bytes += r.value.bytes;
      return r.value.rows;
    }
    sectionErrors[SECTIONS[i]] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return null;
  };
  const [
    overviewRows,
    prevOverviewRows,
    timeseries,
    latencyByAgent,
    toolStats,
    modelComparison,
    topSessions,
    hitl,
    delegation,
    agentRows,
  ] = SECTIONS.map((_, i) => rowsOf(i));

  if (Object.keys(sectionErrors).length === SECTIONS.length) {
    throw new Error(`All dashboard queries failed: ${Object.values(sectionErrors)[0]}`);
  }

  return {
    meta: {
      source: `${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table}`,
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
      agent: agent ?? null,
      bytes_processed: bytes,
      ...(Object.keys(sectionErrors).length ? { section_errors: sectionErrors } : {}),
    },
    overview: overviewRows?.[0] ?? EMPTY_OVERVIEW,
    prevOverview: prevOverviewRows?.[0] ?? null,
    timeseries: timeseries ?? [],
    latencyByAgent: latencyByAgent ?? [],
    toolStats: toolStats ?? [],
    modelComparison: modelComparison ?? [],
    topSessions: topSessions ?? [],
    hitl: hitl ?? [],
    delegation: delegation ?? [],
    agentsList: (agentRows ?? []).map((r: any) => r.agent),
  };
}

// ------------------------------------------------------------ custom widgets

const WIDGET_QUERY_BYTES = Math.min(200_000_000, CONFIG.refreshBytesBudget); // single-query ops

async function loadWidget(spec: WidgetSpec, timeRangeHours: number, dryRun: boolean): Promise<WidgetResult> {
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const granularity: Granularity = spec.granularity ?? (timeRangeHours <= 72 ? "hour" : "day");
  const fullSpec: WidgetSpec = { v: 1, ...spec, granularity };
  if (CONFIG.mock) {
    const result = mockWidget(fullSpec, start, end);
    return dryRun ? { ...result, rows: [], dry_run: true, estimated_bytes: 12_345_678 } : result;
  }
  const built = buildWidgetSql(tableRef(), fullSpec);
  const params = { start: start.toISOString(), end: end.toISOString(), ...built.filterParams };
  const window = { start: start.toISOString(), end: end.toISOString() };
  if (dryRun) {
    const estimated = await dryRunQuery(built.sql, params);
    return { spec: fullSpec as WidgetResult["spec"], window, rows: [], dry_run: true, estimated_bytes: estimated };
  }
  const { rows, bytes } = await runQuery(built.sql, params, WIDGET_QUERY_BYTES);
  return { spec: fullSpec as WidgetResult["spec"], window, rows, bytes_processed: bytes };
}

// ------------------------------------------------ conversational layer (BQCA)

// Ask runs Conversational Analytics work in our project: bound how many run
// at once, and cap the bytes its generated queries may bill (#5).
const MAX_CONCURRENT_ASK = 3;
let inflightAsk = 0;

async function ask(question: string, history: AskExchange[]): Promise<AskResult> {
  if (CONFIG.mock) return mockAsk(question);
  if (inflightAsk >= MAX_CONCURRENT_ASK) {
    throw new Error("Server busy: too many concurrent Ask requests — retry shortly");
  }
  inflightAsk++;
  try {
    return await askConversational(
      {
        project: CONFIG.project,
        dataset: CONFIG.dataset,
        table: CONFIG.table,
        location: process.env.BQAA_CA_LOCATION,
        maxBilledBytes: CONFIG.refreshBytesBudget,
      },
      question,
      history,
    );
  } finally {
    inflightAsk--;
  }
}

async function loadErrorTraces(timeRangeHours: number, limit: number): Promise<ErrorTraceRow[]> {
  if (CONFIG.mock) return mockErrorTraces().slice(0, limit);
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const { rows } = await runQuery(
    buildErrorTracesSql(tableRef()),
    { start: start.toISOString(), end: end.toISOString(), limit },
    WIDGET_QUERY_BYTES,
  );
  return rows;
}

// Cache + coalescing: identical (window, agent) refreshes within the TTL share
// one BigQuery round-trip, including concurrent ones. The cache is a bounded
// LRU — arbitrary agent filters cannot grow it without limit, and expired
// entries are evicted on access.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 50;
const dashboardCache = new Map<string, { promise: Promise<DashboardData>; expires: number }>();

function cacheGet(key: string): { promise: Promise<DashboardData>; expires: number } | null {
  const entry = dashboardCache.get(key);
  if (!entry) return null;
  if (entry.expires <= Date.now()) {
    dashboardCache.delete(key);
    return null;
  }
  dashboardCache.delete(key); // re-insert as most recently used
  dashboardCache.set(key, entry);
  return entry;
}

function cacheSet(key: string, entry: { promise: Promise<DashboardData>; expires: number }): void {
  const now = Date.now();
  for (const [k, e] of dashboardCache) if (e.expires <= now) dashboardCache.delete(k);
  while (dashboardCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = dashboardCache.keys().next().value;
    if (oldest == null) break;
    dashboardCache.delete(oldest);
  }
  dashboardCache.set(key, entry);
}

async function loadDashboard(timeRangeHours: number, agent?: string | null): Promise<DashboardData> {
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const granularity: Granularity = timeRangeHours <= 72 ? "hour" : "day";
  if (CONFIG.mock) return mockDashboard(start, end, granularity, agent);

  const key = `${timeRangeHours}|${agent ?? ""}`;
  const cached = cacheGet(key);
  if (cached) {
    const data = await cached.promise;
    return { ...data, meta: { ...data.meta, cache_hit: true } };
  }
  const promise = bigQueryDashboard(start, end, granularity, agent);
  const entry = { promise, expires: Date.now() + CACHE_TTL_MS };
  cacheSet(key, entry);
  promise
    .then((d) => {
      // #2: a degraded (partial-failure) result must not be served from cache
      // for the full TTL — evict it so the next refresh retries immediately.
      if (Object.keys(d.meta.section_errors ?? {}).length && dashboardCache.get(key) === entry) {
        dashboardCache.delete(key);
      }
    })
    .catch(() => {
      if (dashboardCache.get(key) === entry) dashboardCache.delete(key); // failures are not cacheable
    });
  return promise;
}

const TRACE_EVENT_CAP = 500;

async function loadTrace(traceId: string, timeRangeHours: number): Promise<TraceResult> {
  if (!TRACE_ID_RE.test(traceId)) throw new Error("Invalid trace_id");
  if (CONFIG.mock) return { events: mockTrace(traceId), truncated: false };
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  // fetch cap+1 so truncation is reported instead of silently dropping events
  const { rows } = await runQuery(
    buildTraceSql(tableRef()),
    { trace_id: traceId, start: start.toISOString(), end: end.toISOString(), limit: TRACE_EVENT_CAP + 1 },
    WIDGET_QUERY_BYTES,
  );
  return { events: rows.slice(0, TRACE_EVENT_CAP), truncated: rows.length > TRACE_EVENT_CAP };
}

// ---------------------------------------------------------------- summaries

const n = (v: number | null | undefined): string => (v == null ? "n/a" : v.toLocaleString("en-US"));

function summarize(d: DashboardData): string {
  const o = d.overview;
  const hours = Math.round((Date.parse(d.meta.end) - Date.parse(d.meta.start)) / 3_600_000);
  const topModel = d.modelComparison[0];
  const worstTool = [...d.toolStats].sort((a, b) => b.fail_rate_pct - a.fail_rate_pct)[0];
  const lines = [
    `Agent analytics, last ${hours}h (source: ${d.meta.source}${d.meta.agent ? `, agent=${d.meta.agent}` : ""}):`,
    `- ${n(o.total_events)} events, ${n(o.sessions)} sessions, ${n(o.users)} users, ${n(o.agents)} agents`,
    `- error rate ${o.error_rate_pct ?? "n/a"}%, p95 event latency ${o.p95_latency_ms ?? "n/a"} ms`,
  ];
  if (topModel) lines.push(`- busiest model: ${topModel.model_id} (${n(topModel.calls)} calls, p95 ${topModel.p95_latency_ms ?? "n/a"} ms)`);
  if (worstTool) lines.push(`- highest tool failure rate: ${worstTool.tool_name} at ${worstTool.fail_rate_pct}% of ${n(worstTool.total_calls)} calls`);
  const failed = Object.keys(d.meta.section_errors ?? {});
  if (failed.length) lines.push(`- WARNING: ${failed.length} panel(s) failed to load: ${failed.join(", ")}`);
  lines.push("The interactive dashboard has been rendered for the user.");
  return lines.join("\n");
}

// ---------------------------------------------------------------- MCP server

const resourceUri = "ui://bqaa/dashboard.html";

const metricArgs = {
  time_range_hours: z
    .number()
    .int()
    .min(1)
    .max(MAX_HOURS)
    .default(CONFIG.defaultHours)
    .describe(`Lookback window in hours (default ${CONFIG.defaultHours}, max ${MAX_HOURS} = 90 days)`),
  agent: z.string().max(200).optional().describe("Optional: restrict to a single agent name"),
};

async function metricsHandler(args: { time_range_hours?: number; agent?: string }) {
  const data = await loadDashboard(args.time_range_hours ?? CONFIG.defaultHours, args.agent ?? null);
  return {
    content: [{ type: "text" as const, text: summarize(data) }],
    structuredContent: { data } as any,
  };
}

// ---- custom widgets (measure × dimension × filters), conversational + UI

const MEASURE_KEYS = Object.keys(WIDGET_MEASURES) as [string, ...string[]];
const DIMENSION_KEYS = Object.keys(WIDGET_DIMENSIONS) as [string, ...string[]];

const widgetArgs = {
  measure: z.enum(MEASURE_KEYS).describe(`One of: ${MEASURE_KEYS.join(", ")}`),
  dimension: z.enum(DIMENSION_KEYS).describe(`Group by: ${DIMENSION_KEYS.join(", ")}`),
  time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
  granularity: z.enum(["hour", "day"]).optional().describe("Bucket size when dimension=time"),
  agent: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  status: z.enum(["OK", "ERROR"]).optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Top-N for categorical dimensions (default 20)"),
  dry_run: z.boolean().default(false).describe("Estimate bytes scanned without running the query"),
};

type WidgetArgs = {
  measure: string;
  dimension: string;
  time_range_hours?: number;
  granularity?: Granularity;
  agent?: string;
  model?: string;
  tool?: string;
  status?: "OK" | "ERROR";
  limit?: number;
  dry_run?: boolean;
};

function widgetSpecOf(args: WidgetArgs): WidgetSpec {
  return {
    measure: args.measure,
    dimension: args.dimension,
    granularity: args.granularity,
    limit: args.limit,
    filters: { agent: args.agent, model: args.model, tool: args.tool, status: args.status },
  };
}

function summarizeWidget(r: WidgetResult): string {
  const label = `${WIDGET_MEASURES[r.spec.measure]?.label ?? r.spec.measure} by ${r.spec.dimension}`;
  if (r.dry_run) {
    return `Dry run for "${label}": would scan ~${((r.estimated_bytes ?? 0) / 1e6).toFixed(1)} MB.`;
  }
  const top = r.rows
    .slice(0, 5)
    .map((row) => `${row.dim ?? "(null)"}: ${row.value ?? "n/a"}`)
    .join("; ");
  return `${label} (${r.rows.length} rows): ${top}${r.rows.length > 5 ? "; …" : ""}`;
}

async function widgetHandler(args: WidgetArgs) {
  const result = await loadWidget(widgetSpecOf(args), args.time_range_hours ?? CONFIG.defaultHours, !!args.dry_run);
  return {
    content: [{ type: "text" as const, text: summarizeWidget(result) }],
    structuredContent: { data: result } as any,
  };
}


// Each stateless HTTP request gets its own McpServer: a shared instance
// re-binds its transport on connect(), so concurrent RPCs would race.
function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "BigQuery Agent Analytics Dashboard", version: "0.1.0" });

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
      trace_id: z.string().regex(TRACE_ID_RE).describe("OpenTelemetry trace id"),
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
    },
    outputSchema: { data: z.unknown() },
  },
  async (args) => {
    const trace = await loadTrace(args.trace_id, args.time_range_hours ?? CONFIG.defaultHours);
    const errorCount = trace.events.filter(
      (e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null,
    ).length;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `Trace ${args.trace_id}: ${trace.events.length} events, ${errorCount} errors.` +
            (trace.truncated ? ` TRUNCATED at ${trace.events.length} events — narrow the window for the full trace.` : ""),
        },
      ],
      structuredContent: { data: trace } as any,
    };
  },
);

server.registerTool(
  "query_widget",
  {
    title: "Query a custom widget",
    description:
      "Run one custom analytics widget over agent_events: a measure (count/latency/tokens/error-rate/…) grouped by a dimension (time, agent, model, tool, user, status, event_type) with optional filters. Set dry_run=true to estimate bytes scanned first. Used by the dashboard's Explore tab and for ad-hoc questions.",
    inputSchema: widgetArgs,
    outputSchema: { data: z.unknown() },
  },
  widgetHandler,
);

registerAppTool(
  server,
  "render_widget",
  {
    title: "Render a custom widget",
    description:
      "Build a custom chart from natural language and render it interactively in the dashboard UI: pick a measure, a dimension, and filters. Use when the user asks to visualize a specific slice (e.g. 'show p95 latency by tool for errors').",
    inputSchema: widgetArgs,
    outputSchema: { data: z.unknown() },
    _meta: { ui: { resourceUri } },
  },
  widgetHandler,
);

server.registerTool(
  "ask_data",
  {
    title: "Ask the agent_events table",
    description:
      "Ask a natural-language analytics question about the agent_events table. Answered by BigQuery Conversational Analytics (Gemini Data Analytics): it plans, writes and runs SQL, and returns an answer with the generated SQL and result rows. Slower than the widget tools (~30-60s) but handles open-ended questions.",
    inputSchema: {
      question: z.string().min(3).max(2000).describe("The analytics question, in natural language"),
      history: z
        .array(z.object({ question: z.string().max(2000), answer: z.string().max(4000) }))
        .max(3)
        .optional()
        .describe("Up to 3 prior question/answer exchanges, for follow-up context"),
    },
    outputSchema: { data: z.unknown() },
  },
  async (args) => {
    const result = await ask(args.question, args.history ?? []);
    return {
      content: [{ type: "text" as const, text: result.answer + (result.sql ? `\n\nGenerated SQL:\n${result.sql}` : "") }],
      structuredContent: { data: result } as any,
    };
  },
);

server.registerTool(
  "list_error_traces",
  {
    title: "List recent error traces",
    description:
      "Return recent trace ids that contain errors, with sample error messages — use with get_trace to cite exact evidence when diagnosing failures.",
    inputSchema: {
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
      limit: z.number().int().min(1).max(50).default(10),
    },
    outputSchema: { data: z.unknown() },
  },
  async (args) => {
    const rows = await loadErrorTraces(args.time_range_hours ?? CONFIG.defaultHours, args.limit ?? 10);
    const text = rows.length
      ? `${rows.length} recent trace(s) with errors:\n` +
        rows.map((r) => `- ${r.trace_id} (${r.last_ts}, agents: ${r.agents ?? "?"}) — ${r.sample_errors ?? ""}`).join("\n")
      : "No traces with errors in this window.";
    return { content: [{ type: "text" as const, text }], structuredContent: { data: rows } as any };
  },
);

registerAppResource(server, resourceUri, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
  const html = await fs.readFile(uiBundlePath(), "utf-8");
  return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
});

  return server;
}

// ---------------------------------------------------------------- transport

const app = express();
app.set("trust proxy", true); // Cloud Run terminates TLS; honor X-Forwarded-Proto

function originAllowed(origin: string): boolean {
  return CONFIG.allowedOrigins.includes("*") || CONFIG.allowedOrigins.includes(origin);
}

// MCP transport security: cross-origin callers must present an allowlisted
// Origin. Same-origin requests always pass (browsers DO send Origin on
// same-origin POSTs), as do server-to-server clients with no Origin header.
function checkOrigin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    const host = req.get("host");
    const sameOrigin = origin === `${req.protocol}://${host}` || origin === `https://${host}`;
    if (!sameOrigin && !originAllowed(origin)) {
      res.status(403).json({ error: "Origin not allowed. Configure BQAA_ALLOWED_ORIGINS." });
      return;
    }
  }
  next();
}

// Credentials are accepted from the Authorization header (MCP clients) or an
// HttpOnly cookie set via POST /auth/login (browser pages) — never from URLs,
// per the MCP authorization spec.
function cookieToken(req: express.Request): string {
  const m = /(?:^|;\s*)bqaa_token=([^;]+)/.exec(req.headers.cookie ?? "");
  return m ? decodeURIComponent(m[1]) : "";
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (CONFIG.authToken) {
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${CONFIG.authToken}` && cookieToken(req) !== CONFIG.authToken) {
      res.status(401).json({ error: "Unauthorized. Send Authorization: Bearer <token>, or sign in at /auth/login." });
      return;
    }
  }
  next();
}

app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || originAllowed(origin)),
  }),
);
app.use(express.json({ limit: "2mb" }));

// structured request log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - t0,
      }),
    );
  });
  next();
});

// /healthz is liveness only (also: GFE intercepts it on run.app). Readiness
// lives at /api/health and actually proves BigQuery access with a cached,
// zero-cost dry run — green must mean "can serve data".
let bqProbe: { ok: boolean; detail: string; checked: number } = { ok: true, detail: "unchecked", checked: 0 };

async function probeBigQuery(): Promise<{ ok: boolean; detail: string }> {
  if (CONFIG.mock) return { ok: true, detail: "mock" };
  if (Date.now() - bqProbe.checked < 60_000) return bqProbe;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 3_600_000);
    await dryRunQuery(`SELECT 1 FROM ${tableRef()} WHERE timestamp BETWEEN @start AND @end LIMIT 1`, {
      start: start.toISOString(),
      end: end.toISOString(),
    });
    bqProbe = { ok: true, detail: "ok", checked: Date.now() };
  } catch (e) {
    bqProbe = { ok: false, detail: e instanceof Error ? e.message : String(e), checked: Date.now() };
  }
  return bqProbe;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, mock: CONFIG.mock, uiBundle: existsSync(uiBundlePath()) });
});

app.get("/api/health", async (_req, res) => {
  const bundle = existsSync(uiBundlePath());
  const bq = await probeBigQuery();
  const ok = bundle && bq.ok;
  res.status(ok ? 200 : 503).json({ ok, mock: CONFIG.mock, uiBundle: bundle, bigquery: bq.detail });
});

// Browser-shareable view: the shell is static; all data endpoints are guarded.
app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(uiBundlePath(), "utf-8");
    res.type("html").send(html);
  } catch {
    res.status(500).send("UI bundle missing — run `npm run build` first.");
  }
});

// Browser sign-in: exchanges the token once (in a POST body) for an HttpOnly
// cookie, so the secret never appears in a URL or in page JavaScript.
app.post("/auth/login", checkOrigin, (req, res) => {
  if (!CONFIG.authToken) {
    res.status(204).end();
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (token !== CONFIG.authToken) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `bqaa_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
  );
  res.status(204).end();
});

app.get("/api/dashboard", checkOrigin, requireAuth, async (req, res) => {
  try {
    const hours = Math.min(MAX_HOURS, Math.max(1, Math.trunc(Number(req.query.time_range_hours)) || CONFIG.defaultHours));
    const agentRaw = typeof req.query.agent === "string" ? req.query.agent.slice(0, 200) : "";
    const data = await loadDashboard(hours, agentRaw || null);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/trace", checkOrigin, requireAuth, async (req, res) => {
  try {
    const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id : "";
    if (!TRACE_ID_RE.test(traceId)) {
      res.status(400).json({ error: "Invalid trace_id" });
      return;
    }
    const hours = Math.min(MAX_HOURS, Math.max(1, Math.trunc(Number(req.query.time_range_hours)) || CONFIG.defaultHours));
    const trace = await loadTrace(traceId, hours);
    res.json({ data: trace.events, truncated: trace.truncated });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/widget", checkOrigin, requireAuth, async (req, res) => {
  try {
    const q = req.query;
    const str = (k: string): string | undefined =>
      typeof q[k] === "string" && q[k] !== "" ? (q[k] as string).slice(0, 200) : undefined;
    const measure = str("measure") ?? "";
    const dimension = str("dimension") ?? "";
    if (!WIDGET_MEASURES[measure] || !WIDGET_DIMENSIONS[dimension]) {
      res.status(400).json({ error: `Unknown measure or dimension. Measures: ${MEASURE_KEYS.join(", ")}; dimensions: ${DIMENSION_KEYS.join(", ")}` });
      return;
    }
    const hours = Math.min(MAX_HOURS, Math.max(1, Math.trunc(Number(q.time_range_hours)) || CONFIG.defaultHours));
    const limitRaw = Math.trunc(Number(q.limit));
    const status = str("status");
    const spec: WidgetSpec = {
      measure,
      dimension,
      granularity: str("granularity") === "hour" ? "hour" : str("granularity") === "day" ? "day" : undefined,
      limit: Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(100, limitRaw) : undefined,
      filters: {
        agent: str("agent"),
        model: str("model"),
        tool: str("tool"),
        status: status === "OK" || status === "ERROR" ? status : undefined,
      },
    };
    const data = await loadWidget(spec, hours, q.dry_run === "1");
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/ask", checkOrigin, requireAuth, async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (question.length < 3 || question.length > 2000) {
      res.status(400).json({ error: "question must be 3-2000 characters" });
      return;
    }
    const history: AskExchange[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((h: any) => typeof h?.question === "string" && typeof h?.answer === "string")
          .slice(-3)
      : [];
    const data = await ask(question, history);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/mcp", checkOrigin, requireAuth, async (req, res) => {
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(CONFIG.port, () => {
  const authNote = CONFIG.authToken ? "auth: bearer token" : "auth: NONE (set BQAA_AUTH_TOKEN)";
  const originNote = CONFIG.allowedOrigins.length
    ? `origins: ${CONFIG.allowedOrigins.join(",")}`
    : "origins: same-origin only";
  console.log(
    `BQAA dashboard MCP server on http://localhost:${CONFIG.port}/mcp ` +
      (CONFIG.mock
        ? "(mock data — set BQAA_PROJECT/BQAA_DATASET/BQAA_TABLE for BigQuery)"
        : `(BigQuery: ${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table})`) +
      ` [${authNote}; ${originNote}]`,
  );
});
