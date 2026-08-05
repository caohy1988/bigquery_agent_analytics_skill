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
import { mockDashboard, mockTrace } from "./src/mock.js";
import { buildDashboardSql, buildTraceSql, SECTIONS } from "./src/queries.js";
import type { DashboardData, Granularity, OverviewStats, TraceEvent } from "./src/types.js";

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
  refreshBytesBudget: intEnv("BQAA_MAX_BYTES_BILLED", 2_000_000_000, 10_000_000, 1_000_000_000_000),
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

interface QueryResult {
  rows: any[];
  bytes: number;
}

async function runQuery(
  sql: string,
  params: Record<string, unknown>,
  maxBytes: number,
): Promise<QueryResult> {
  if (!bqClient) {
    const { BigQuery } = await import("@google-cloud/bigquery");
    bqClient = new BigQuery({ projectId: CONFIG.project });
  }
  const [job] = await bqClient.createQueryJob({
    query: sql,
    params,
    maximumBytesBilled: String(maxBytes),
  });
  const [rows] = await job.getQueryResults();
  const [meta] = await job.getMetadata();
  return { rows, bytes: Number(meta?.statistics?.totalBytesProcessed ?? 0) };
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
  const agentsParams = { start: params.start, end: params.end };

  // The refresh budget is split evenly across the panel queries so one
  // dashboard load can never authorize more than BQAA_MAX_BYTES_BILLED total.
  const perQueryBytes = Math.max(10_000_000, Math.floor(CONFIG.refreshBytesBudget / SECTIONS.length));

  const settled = await Promise.allSettled(
    SECTIONS.map((s) => runQuery(sql[s], s === "agents" ? agentsParams : params, perQueryBytes)),
  );

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
  const [overviewRows, timeseries, latencyByAgent, toolStats, modelComparison, topSessions, agentRows] =
    SECTIONS.map((_, i) => rowsOf(i));

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
    timeseries: timeseries ?? [],
    latencyByAgent: latencyByAgent ?? [],
    toolStats: toolStats ?? [],
    modelComparison: modelComparison ?? [],
    topSessions: topSessions ?? [],
    agentsList: (agentRows ?? []).map((r: any) => r.agent),
  };
}

// Cache + coalescing: identical (window, agent) refreshes within the TTL share
// one BigQuery round-trip, including concurrent ones.
const CACHE_TTL_MS = 60_000;
const dashboardCache = new Map<string, { promise: Promise<DashboardData>; expires: number }>();

async function loadDashboard(timeRangeHours: number, agent?: string | null): Promise<DashboardData> {
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const granularity: Granularity = timeRangeHours <= 72 ? "hour" : "day";
  if (CONFIG.mock) return mockDashboard(start, end, granularity, agent);

  const key = `${timeRangeHours}|${agent ?? ""}`;
  const cached = dashboardCache.get(key);
  if (cached && cached.expires > Date.now()) {
    const data = await cached.promise;
    return { ...data, meta: { ...data.meta, cache_hit: true } };
  }
  const promise = bigQueryDashboard(start, end, granularity, agent);
  dashboardCache.set(key, { promise, expires: Date.now() + CACHE_TTL_MS });
  promise.catch(() => dashboardCache.delete(key)); // failures are not cacheable
  return promise;
}

async function loadTrace(traceId: string, timeRangeHours: number): Promise<TraceEvent[]> {
  if (!TRACE_ID_RE.test(traceId)) throw new Error("Invalid trace_id");
  if (CONFIG.mock) return mockTrace(traceId);
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const { rows } = await runQuery(
    buildTraceSql(tableRef()),
    { trace_id: traceId, start: start.toISOString(), end: end.toISOString() },
    Math.max(10_000_000, Math.floor(CONFIG.refreshBytesBudget / SECTIONS.length)),
  );
  return rows;
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

const server = new McpServer({ name: "BigQuery Agent Analytics Dashboard", version: "0.1.0" });

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
    const events = await loadTrace(args.trace_id, args.time_range_hours ?? CONFIG.defaultHours);
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
  const html = await fs.readFile(uiBundlePath(), "utf-8");
  return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
});

// ---------------------------------------------------------------- transport

const app = express();

function originAllowed(origin: string): boolean {
  return CONFIG.allowedOrigins.includes("*") || CONFIG.allowedOrigins.includes(origin);
}

// MCP transport security: cross-origin callers must present an allowlisted
// Origin. Same-origin browser requests and server-to-server clients send no
// Origin header and pass through.
function checkOrigin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  if (origin && !originAllowed(origin)) {
    res.status(403).json({ error: "Origin not allowed. Configure BQAA_ALLOWED_ORIGINS." });
    return;
  }
  next();
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (CONFIG.authToken) {
    const header = req.headers.authorization ?? "";
    const queryToken = typeof req.query.token === "string" ? req.query.token : "";
    if (header !== `Bearer ${CONFIG.authToken}` && queryToken !== CONFIG.authToken) {
      res.status(401).json({ error: "Unauthorized. Send Authorization: Bearer <BQAA_AUTH_TOKEN>." });
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

// /healthz is intercepted by Google Frontend on run.app, so the canonical
// health endpoint lives under /api/; /healthz still works locally.
const health = (_req: express.Request, res: express.Response): void => {
  res.json({ ok: true, mock: CONFIG.mock, uiBundle: existsSync(uiBundlePath()) });
};
app.get("/api/health", health);
app.get("/healthz", health);

// Browser-shareable view: the shell is static; all data endpoints are guarded.
app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(uiBundlePath(), "utf-8");
    res.type("html").send(html);
  } catch {
    res.status(500).send("UI bundle missing — run `npm run build` first.");
  }
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
    const data = await loadTrace(traceId, hours);
    res.json({ data });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/mcp", checkOrigin, requireAuth, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  await server.connect(transport);
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
