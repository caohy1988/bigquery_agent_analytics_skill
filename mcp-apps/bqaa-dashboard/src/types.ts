// Shared shapes between server.ts (producer) and src/mcp-app.ts (consumer).
// See GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396 for the design.

export type Granularity = "hour" | "day";

export interface DashboardMeta {
  source: string; // "project.dataset.table" or "mock"
  start: string; // ISO timestamp
  end: string; // ISO timestamp
  granularity: Granularity;
  agent: string | null; // active agent filter, if any
  bytes_processed?: number | null; // total BigQuery bytes for this refresh
  cache_hit?: boolean;
  // Panels whose query failed this refresh; healthy panels still render.
  section_errors?: Record<string, string>;
}

export interface OverviewStats {
  total_events: number | null;
  errors: number | null;
  error_rate_pct: number | null;
  sessions: number | null;
  agents: number | null;
  users: number | null;
  p95_latency_ms: number | null;
  last_event_ts?: string | null; // newest event in window — freshness indicator
}

export interface HitlRow {
  agent: string | null;
  request_type: string | null; // CREDENTIAL / CONFIRMATION / INPUT
  total_requests: number;
  completed: number;
  avg_wait_sec: number | null;
  max_wait_sec: number | null;
}

export interface DelegationRow {
  parent_agent: string;
  child_agent: string;
  delegation_count: number;
  unique_traces: number;
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
  trace_ids?: string[]; // sample trace ids for drill-down
}

export interface DashboardData {
  meta: DashboardMeta;
  overview: OverviewStats;
  prevOverview?: OverviewStats | null; // same stats for the preceding window
  timeseries: TimeBucket[];
  latencyByAgent: AgentLatencyRow[];
  toolStats: ToolStatRow[];
  modelComparison: ModelComparisonRow[];
  topSessions: SessionTokenRow[];
  hitl?: HitlRow[];
  delegation?: DelegationRow[];
  agentsList: string[];
}

// ------------------------------------------------------------ custom widgets
// Versioned widget contract: measure × dimension × filters × window.

export const WIDGET_SPEC_VERSION = 1;

export interface WidgetFilters {
  agent?: string;
  model?: string;
  tool?: string;
  status?: "OK" | "ERROR";
}

export interface WidgetSpec {
  v?: number; // spec version, WIDGET_SPEC_VERSION
  measure: string; // key in WIDGET_MEASURES
  dimension: string; // key in WIDGET_DIMENSIONS
  granularity?: Granularity; // only for dimension === "time"
  filters?: WidgetFilters;
  limit?: number; // categorical dimensions only, 1..100
}

export interface WidgetRow {
  dim: string | null;
  value: number | null;
}

export interface WidgetResult {
  spec: Required<Pick<WidgetSpec, "measure" | "dimension">> & WidgetSpec;
  window: { start: string; end: string };
  rows: WidgetRow[];
  bytes_processed?: number | null;
  estimated_bytes?: number | null; // dry-run only
  dry_run?: boolean;
}

export interface ErrorTraceRow {
  trace_id: string;
  last_ts: string;
  agents: string | null;
  error_events: number;
  sample_errors: string | null;
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
