// Deterministic synthetic agent_events aggregates. Used by server.ts when
// BQAA_MOCK=1 (or no BQAA_PROJECT is set) and by the UI's standalone preview.
// Browser-safe: no Node APIs.

import { sqlStringLiteral } from "./sqltext.js";
import type {
  AgentLatencyRow,
  AskResult,
  DashboardData,
  DelegationRow,
  ErrorTraceRow,
  Granularity,
  HitlRow,
  ModelComparisonRow,
  SessionTokenRow,
  TimeBucket,
  ToolStatRow,
  TraceEvent,
  WidgetResult,
  WidgetSpec,
} from "./types.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENTS = ["orchestrator", "researcher", "coder", "critic"];
const MODELS = ["gemini-2.5-pro", "gemini-2.5-flash"];
const TOOLS: Array<[string, string]> = [
  ["web_search", "builtin"],
  ["run_sql", "mcp"],
  ["read_file", "builtin"],
  ["send_email", "mcp"],
  ["vector_search", "mcp"],
];

export function mockDashboard(
  start: Date,
  end: Date,
  granularity: Granularity,
  agentFilter?: string | null,
): DashboardData {
  const rand = mulberry32(1234567);
  const stepMs = granularity === "hour" ? 3_600_000 : 86_400_000;
  const t0 = Math.floor(start.getTime() / stepMs) * stepMs;
  // Filtering to one agent scales volume down but keeps shapes recognizable.
  const scale = agentFilter ? 0.35 : 1;

  const timeseries: TimeBucket[] = [];
  let totalEvents = 0;
  let totalErrors = 0;
  let llmCallsTotal = 0;
  let promptTotal = 0;
  let completionTotal = 0;
  for (let t = t0; t < end.getTime(); t += stepMs) {
    const phase = (t / stepMs) % (granularity === "hour" ? 24 : 7);
    const daily =
      granularity === "hour"
        ? 0.55 + 0.45 * Math.sin(((phase - 6) / 24) * 2 * Math.PI)
        : 0.75 + 0.25 * Math.sin((phase / 7) * 2 * Math.PI);
    const events = Math.round((120 + rand() * 80) * daily * scale) + 5;
    const errors = Math.round(events * (0.015 + rand() * 0.04));
    const llmCalls = Math.round(events * 0.34);
    const prompt = llmCalls * Math.round(2200 + rand() * 1400);
    const completion = llmCalls * Math.round(350 + rand() * 250);
    const p50 = 900 + rand() * 500;
    const p95 = p50 * (2.4 + rand() * 1.2);
    totalEvents += events;
    totalErrors += errors;
    llmCallsTotal += llmCalls;
    promptTotal += prompt;
    completionTotal += completion;
    timeseries.push({
      ts: new Date(t).toISOString(),
      events,
      errors,
      llm_calls: llmCalls,
      prompt_tokens: prompt,
      completion_tokens: completion,
      p50_latency_ms: Math.round(p50),
      p95_latency_ms: Math.round(p95),
    });
  }

  const agents = agentFilter ? [agentFilter] : AGENTS;
  const latencyByAgent: AgentLatencyRow[] = [];
  for (const agent of agents) {
    for (const model of MODELS) {
      const base = 600 + rand() * 900 + (model.endsWith("pro") ? 700 : 0);
      const calls = Math.round((llmCallsTotal / (agents.length * MODELS.length)) * (0.6 + rand() * 0.8));
      latencyByAgent.push({
        agent,
        model_id: model,
        calls,
        avg_total_ms: Math.round(base * 1.4),
        avg_ttft_ms: Math.round(base * 0.45),
        p50_total_ms: Math.round(base * 1.2),
        p95_total_ms: Math.round(base * 3.1),
        p99_total_ms: Math.round(base * 5.2),
      });
    }
  }
  latencyByAgent.sort((a, b) => (b.p95_total_ms ?? 0) - (a.p95_total_ms ?? 0));

  const toolStats: ToolStatRow[] = TOOLS.map(([tool_name, tool_origin]) => {
    const total = Math.round(totalEvents * (0.03 + rand() * 0.06));
    const failures = Math.round(total * (0.005 + rand() * 0.09));
    const avg = 150 + rand() * 1800;
    return {
      tool_name,
      tool_origin,
      total_calls: total,
      failures,
      fail_rate_pct: total ? Math.round((failures / total) * 10000) / 100 : 0,
      avg_latency_ms: Math.round(avg),
      p95_latency_ms: Math.round(avg * 2.8),
    };
  }).sort((a, b) => b.total_calls - a.total_calls);

  const modelComparison: ModelComparisonRow[] = MODELS.map((model) => {
    const calls = Math.round(llmCallsTotal * (model.endsWith("flash") ? 0.64 : 0.36));
    const base = model.endsWith("pro") ? 2100 : 950;
    const share = model.endsWith("flash") ? 0.64 : 0.36;
    return {
      model_id: model,
      calls,
      error_rate_pct: Math.round((0.4 + rand() * 2.2) * 100) / 100,
      total_prompt_tokens: Math.round(promptTotal * share),
      total_completion_tokens: Math.round(completionTotal * share),
      avg_total_tokens: Math.round(2800 + rand() * 900),
      avg_prompt_tokens: Math.round(2300 + rand() * 700),
      avg_completion_tokens: Math.round(420 + rand() * 180),
      avg_latency_ms: Math.round(base * 1.3),
      p50_latency_ms: Math.round(base * 1.1),
      p95_latency_ms: Math.round(base * 2.9),
      avg_ttft_ms: Math.round(base * 0.4),
    };
  });

  const topSessions: SessionTokenRow[] = [];
  for (let i = 0; i < 12; i++) {
    const llmCalls = Math.round(8 + rand() * 90);
    const prompt = llmCalls * Math.round(2000 + rand() * 2500);
    const completion = llmCalls * Math.round(300 + rand() * 400);
    topSessions.push({
      session_id: `sess-${(1000 + Math.floor(rand() * 9000)).toString(16)}${i}`,
      model_id: MODELS[i % MODELS.length],
      llm_calls: llmCalls,
      total_prompt_tokens: prompt,
      total_completion_tokens: completion,
      total_tokens: prompt + completion,
      trace_ids: [`trace${(0x10000000 + Math.floor(rand() * 0xefffffff)).toString(16)}${i}`],
    });
  }
  topSessions.sort((a, b) => b.total_tokens - a.total_tokens);

  const allLatency = timeseries.map((b) => b.p95_latency_ms ?? 0).sort((a, b) => a - b);
  const p95 = allLatency[Math.floor(allLatency.length * 0.95)] ?? null;

  const hitl: HitlRow[] = agents.slice(0, 2).flatMap((agent) =>
    ["CONFIRMATION", "INPUT"].map((request_type) => {
      const total = Math.round(4 + rand() * 30);
      return {
        agent,
        request_type,
        total_requests: total,
        completed: Math.round(total * (0.82 + rand() * 0.18)),
        avg_wait_sec: Math.round((10 + rand() * 240) * 10) / 10,
        max_wait_sec: Math.round(300 + rand() * 3000),
      };
    }),
  );

  const delegation: DelegationRow[] =
    agents.length > 1
      ? agents.slice(1).map((child) => ({
          parent_agent: agents[0],
          child_agent: child,
          delegation_count: Math.round(30 + rand() * 400),
          unique_traces: Math.round(20 + rand() * 200),
        }))
      : [];

  return {
    meta: {
      source: "mock",
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
      agent: agentFilter ?? null,
    },
    overview: {
      total_events: totalEvents,
      errors: totalErrors,
      error_rate_pct: totalEvents ? Math.round((totalErrors / totalEvents) * 10000) / 100 : 0,
      sessions: Math.round(totalEvents / 38),
      agents: agents.length,
      users: Math.round(totalEvents / 130),
      p95_latency_ms: p95,
      last_event_ts: timeseries.length ? timeseries[timeseries.length - 1].ts : null,
    },
    prevOverview: {
      total_events: Math.round(totalEvents * 0.91),
      errors: Math.round(totalErrors * 1.18),
      error_rate_pct: totalEvents ? Math.round(((totalErrors * 1.18) / (totalEvents * 0.91)) * 10000) / 100 : 0,
      sessions: Math.round(totalEvents / 41),
      agents: agents.length,
      users: Math.round(totalEvents / 138),
      p95_latency_ms: p95 != null ? Math.round(p95 * 1.12) : null,
    },
    timeseries,
    latencyByAgent,
    toolStats,
    modelComparison,
    topSessions,
    hitl,
    delegation,
    agentsList: AGENTS,
  };
}

export function mockWidget(spec: WidgetSpec, start: Date, end: Date): WidgetResult {
  // #8(r9): the seed covers the FULL normalized spec — filters included — and
  // categorical rows honor a matching dimension filter instead of ignoring it
  const rand = mulberry32(
    stringSeed(JSON.stringify({ m: spec.measure, d: spec.dimension, g: spec.granularity, f: spec.filters ?? {} })),
  );
  const scale =
    spec.measure.includes("tokens") ? 250_000 : spec.measure.includes("ms") ? 4000 : spec.measure.includes("pct") ? 5 : 900;
  let rows;
  if (spec.dimension === "time") {
    const stepMs = spec.granularity === "hour" ? 3_600_000 : 86_400_000;
    rows = [];
    for (let t = Math.floor(start.getTime() / stepMs) * stepMs; t < end.getTime(); t += stepMs) {
      rows.push({ dim: new Date(t).toISOString(), value: Math.round(scale * (0.4 + rand())) });
    }
  } else {
    const values: Record<string, string[]> = {
      agent: AGENTS,
      model: MODELS,
      tool: TOOLS.map(([t]) => t),
      user: ["user-a", "user-b", "user-c", "user-d"],
      status: ["OK", "ERROR"],
      event_type: ["LLM_RESPONSE", "LLM_REQUEST", "TOOL_COMPLETED", "TOOL_STARTING"],
    };
    const domain = values[spec.dimension] ?? ["a", "b"];
    const filterValue = (spec.filters as Record<string, string | undefined> | undefined)?.[spec.dimension];
    // #11(r10): a filter SELECTS from the synthetic domain — it never invents
    // the requested value. Filtering to an absent entity returns zero rows,
    // exactly like BigQuery would.
    const candidates = filterValue ? domain.filter((v) => v === filterValue) : domain;
    rows = candidates.map((dim) => ({
      dim,
      value: Math.round(scale * (0.2 + rand())),
    }));
    rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    // #12(r10): same categorical limit contract as production (default 20, 1..100)
    const requested = Number.isInteger(spec.limit) ? (spec.limit as number) : 20;
    rows = rows.slice(0, Math.min(100, Math.max(1, requested)));
  }
  return {
    spec: { v: 1, ...spec },
    window: { start: start.toISOString(), end: end.toISOString() },
    rows,
  };
}

// #13(r10): ONE deterministic fixture is the source of truth for which mock
// traces contain errors and how many — the error list and every per-trace
// drill-down must agree, so a listed trace always round-trips to the same
// positive error count.
const ERROR_TRACE_FIXTURE: Array<{ trace_id: string; error_events: number; sample_error: string; agent: string }> = (() => {
  const rand = mulberry32(77);
  return Array.from({ length: 6 }, (_, i) => ({
    trace_id: `trace${(0x20000000 + Math.floor(rand() * 0xdfffffff)).toString(16)}${i}`,
    error_events: 1 + Math.floor(rand() * 3),
    sample_error: ["TimeoutError: tool call exceeded 30s", "PermissionDenied: missing scope", "RateLimitError"][i % 3],
    agent: AGENTS[i % AGENTS.length],
  }));
})();

export function mockErrorTraces(): ErrorTraceRow[] {
  return ERROR_TRACE_FIXTURE.map((f, i) => ({
    trace_id: f.trace_id,
    last_ts: new Date(Date.now() - i * 5_400_000).toISOString(),
    agents: f.agent,
    error_events: f.error_events,
    sample_errors: f.sample_error,
  }));
}

export function mockTrace(traceId: string): TraceEvent[] {
  const rand = mulberry32(traceId.length * 7919 + 17);
  const t0 = Date.now() - 3_600_000;
  const events: TraceEvent[] = [];
  let t = t0;
  const push = (e: Partial<TraceEvent>) => {
    events.push({
      timestamp: new Date(t).toISOString(),
      event_type: "LLM_REQUEST",
      agent: "orchestrator",
      invocation_id: "inv-1",
      span_id: null,
      parent_span_id: null,
      llm_response: null,
      tool_name: null,
      tool_origin: null,
      latency_ms: null,
      status: "OK",
      error_message: null,
      ...e,
    });
  };
  // #13(r10): a trace listed in the error fixture shows EXACTLY its listed
  // error count with its listed message; unlisted traces are error-free, so
  // the mock error list is complete as well as consistent.
  const fx = ERROR_TRACE_FIXTURE.find((f) => f.trace_id === traceId);
  push({ event_type: "LLM_REQUEST", span_id: "s1" });
  t += 1200;
  push({ event_type: "LLM_RESPONSE", span_id: "s1", llm_response: "Plan: search then summarize.", latency_ms: 1200 });
  const toolCount = Math.max(2 + Math.floor(rand() * 3), fx?.error_events ?? 0);
  for (let i = 0; i < toolCount; i++) {
    t += 300;
    const [tool, origin] = TOOLS[Math.floor(rand() * TOOLS.length)];
    push({ event_type: "TOOL_STARTING", agent: fx?.agent ?? "researcher", span_id: `t${i}`, parent_span_id: "s1", tool_name: tool, tool_origin: origin });
    t += Math.round(200 + rand() * 1500);
    const isError = fx != null && i < fx.error_events;
    push({
      event_type: isError ? "TOOL_ERROR" : "TOOL_COMPLETED",
      agent: fx?.agent ?? "researcher",
      span_id: `t${i}`,
      parent_span_id: "s1",
      tool_name: tool,
      tool_origin: origin,
      latency_ms: Math.round(200 + rand() * 1500),
      status: isError ? "ERROR" : "OK",
      error_message: isError ? fx.sample_error : null,
    });
  }
  t += 900;
  push({ event_type: "LLM_RESPONSE", span_id: "s2", parent_span_id: "s1", llm_response: "Final answer.", latency_ms: 900 });
  return events;
}

function stringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mockAsk(question: string, scope?: { startIso: string; endIso: string; agent?: string }): AskResult {
  // #6(r8): sample VALUES derive deterministically from the scope — disjoint
  // windows/agents produce different numbers, so a fixed fixture can never
  // masquerade as two different slices. SQL carries the actual predicates.
  const windowPredicate = scope
    ? `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'${scope.agent ? ` AND agent = ${sqlStringLiteral(scope.agent)}` : ""}`
    : "timestamp > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)";
  const randAsk = mulberry32(stringSeed(scope ? `${scope.startIso}|${scope.endIso}|${scope.agent ?? ""}` : "unscoped"));
  const mk = (base: number): { starting: number; errors: number; rate: number } => {
    const starting = Math.round(base * (0.5 + randAsk()));
    const errors = Math.round(starting * (0.04 + randAsk() * 0.05));
    return { starting, errors, rate: Math.round((errors / starting) * 1000) / 1000 };
  };
  // #10(r9): ONE sorted row set drives the rows, the prose, and the SQL —
  // the sample can never contradict itself
  const sampleRows = ["fetch_invoice", "check_inventory", "search_kb"]
    .map((tool_name, i) => {
      const { starting, errors, rate } = mk(2800 - i * 100);
      return { tool_name, starting_count: starting, error_count: errors, failure_rate: rate };
    })
    .sort((x, y) => y.failure_rate - x.failure_rate);
  const top = sampleRows[0];
  const second = sampleRows[1];
  return {
    question,
    answer:
      `**${top.tool_name}** has the highest failure rate at **${(top.failure_rate * 100).toFixed(1)}%** of started executions (${top.error_count} errors out of ${top.starting_count.toLocaleString("en-US")} starts), followed by ${second.tool_name} at ${(second.failure_rate * 100).toFixed(1)}%.\n\n` +
      `(Sample answer from mock data${scope ? ", generated for your selected scope" : ""} — connect a BigQuery project to ask real questions.)`,
    steps: ["Analyzing context", "Running a query", "Tool failure analysis"],
    sql: `WITH tool_stats AS (\n  SELECT LAX_STRING(content.tool) AS tool_name,\n    COUNTIF(event_type = 'TOOL_STARTING') AS starting_count,\n    COUNTIF(event_type = 'TOOL_ERROR') AS error_count\n  FROM \`project.dataset.agent_events\`\n  WHERE ${windowPredicate}\n  GROUP BY tool_name\n)\nSELECT tool_name, starting_count, error_count, error_count / starting_count AS failure_rate\nFROM tool_stats ORDER BY failure_rate DESC`,
    schema: ["tool_name", "starting_count", "error_count", "failure_rate"],
    rows: sampleRows,
    followups: [
      `What are the most common error messages for ${top.tool_name}?`,
      "What is the failure rate broken down by agent?",
      "Show me the daily trend of failures.",
    ],
    ...(scope ? { scope: { ...scope, verified: true } } : {}),
  };
}
