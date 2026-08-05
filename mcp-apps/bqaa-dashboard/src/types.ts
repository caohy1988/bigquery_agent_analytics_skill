// Shared shapes between server.ts (producer) and src/mcp-app.ts (consumer).
// See GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396 for the design.

export type Granularity = "hour" | "day";

export interface DashboardMeta {
  source: string; // "project.dataset.table" or "mock"
  start: string; // ISO timestamp
  end: string; // ISO timestamp
  granularity: Granularity;
  agent: string | null; // active agent filter, if any
}

export interface OverviewStats {
  total_events: number;
  errors: number;
  error_rate_pct: number;
  sessions: number;
  agents: number;
  users: number;
  p95_latency_ms: number | null;
}

export interface TimeBucket {
  ts: string; // ISO bucket start
  events: number;
  errors: number;
  llm_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
}

export interface AgentLatencyRow {
  agent: string;
  model_id: string | null;
  calls: number;
  avg_total_ms: number | null;
  avg_ttft_ms: number | null;
  p50_total_ms: number | null;
  p95_total_ms: number | null;
  p99_total_ms: number | null;
}

export interface ToolStatRow {
  tool_name: string | null;
  tool_origin: string | null;
  total_calls: number;
  failures: number;
  fail_rate_pct: number;
  avg_latency_ms: number | null;
  p95_latency_ms: number | null;
}

export interface ModelComparisonRow {
  model_id: string | null;
  calls: number;
  error_rate_pct: number;
  avg_total_tokens: number | null;
  avg_prompt_tokens: number | null;
  avg_completion_tokens: number | null;
  avg_latency_ms: number | null;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  avg_ttft_ms: number | null;
}

export interface SessionTokenRow {
  session_id: string;
  model_id: string | null;
  llm_calls: number;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_tokens: number;
}

export interface DashboardData {
  meta: DashboardMeta;
  overview: OverviewStats;
  timeseries: TimeBucket[];
  latencyByAgent: AgentLatencyRow[];
  toolStats: ToolStatRow[];
  modelComparison: ModelComparisonRow[];
  topSessions: SessionTokenRow[];
  agentsList: string[];
}

export interface TraceEvent {
  timestamp: string;
  event_type: string;
  agent: string | null;
  invocation_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  llm_response: string | null;
  tool_name: string | null;
  tool_origin: string | null;
  latency_ms: number | null;
  status: string | null;
  error_message: string | null;
}
