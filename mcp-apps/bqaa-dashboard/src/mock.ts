// Deterministic synthetic agent_events aggregates. Used by server.ts when
// BQAA_MOCK=1 (or no BQAA_PROJECT is set) and by the UI's standalone preview.
// Browser-safe: no Node APIs.

import type {
  AgentLatencyRow,
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
    return {
      model_id: model,
      calls,
      error_rate_pct: Math.round((0.4 + rand() * 2.2) * 100) / 100,
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
  const rand = mulberry32(spec.measure.length * 131 + spec.dimension.length * 17);
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
    rows = (values[spec.dimension] ?? ["a", "b"]).map((dim) => ({
      dim,
      value: Math.round(scale * (0.2 + rand())),
    }));
    rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  }
  return {
    spec: { v: 1, ...spec },
    window: { start: start.toISOString(), end: end.toISOString() },
    rows,
  };
}

export function mockErrorTraces(): ErrorTraceRow[] {
  const rand = mulberry32(77);
  return Array.from({ length: 6 }, (_, i) => ({
    trace_id: `trace${(0x20000000 + Math.floor(rand() * 0xdfffffff)).toString(16)}${i}`,
    last_ts: new Date(Date.now() - i * 5_400_000).toISOString(),
    agents: AGENTS[i % AGENTS.length],
    error_events: 1 + Math.floor(rand() * 3),
    sample_errors: ["TimeoutError: tool call exceeded 30s", "PermissionDenied: missing scope", "RateLimitError"][i % 3],
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
  push({ event_type: "LLM_REQUEST", span_id: "s1" });
  t += 1200;
  push({ event_type: "LLM_RESPONSE", span_id: "s1", llm_response: "Plan: search then summarize.", latency_ms: 1200 });
  for (let i = 0; i < 2 + Math.floor(rand() * 3); i++) {
    t += 300;
    const [tool, origin] = TOOLS[Math.floor(rand() * TOOLS.length)];
    push({ event_type: "TOOL_STARTING", agent: "researcher", span_id: `t${i}`, parent_span_id: "s1", tool_name: tool, tool_origin: origin });
    t += Math.round(200 + rand() * 1500);
    push({
      event_type: "TOOL_COMPLETED",
      agent: "researcher",
      span_id: `t${i}`,
      parent_span_id: "s1",
      tool_name: tool,
      tool_origin: origin,
      latency_ms: Math.round(200 + rand() * 1500),
      status: rand() < 0.12 ? "ERROR" : "OK",
    });
  }
  t += 900;
  push({ event_type: "LLM_RESPONSE", span_id: "s2", parent_span_id: "s1", llm_response: "Final answer.", latency_ms: 900 });
  return events;
}
