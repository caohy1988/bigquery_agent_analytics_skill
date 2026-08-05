// SQL contract tests — assert the metric contract without touching BigQuery.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDashboardSql,
  buildTraceSql,
  MODEL_EXPR,
  PROMPT_TOK_EXPR,
  COMPLETION_TOK_EXPR,
  SECTIONS,
} from "../src/queries.js";

const sql = buildDashboardSql({ table: "`p.d.t`", granularity: "day", agentFilter: false });

test("every section has a query", () => {
  for (const s of SECTIONS) assert.ok(sql[s]?.length > 0, `missing sql for ${s}`);
});

test("every query carries the mandatory partition predicate", () => {
  for (const s of SECTIONS) {
    assert.match(sql[s], /timestamp BETWEEN @start AND @end/, `${s} lacks time predicate`);
  }
});

test("agent filter is parameterized, never interpolated", () => {
  const filtered = buildDashboardSql({ table: "`p.d.t`", granularity: "hour", agentFilter: true });
  // "agents" (the filter's own option list) and "delegation" (parent→child
  // pairs span two agents) intentionally ignore the agent filter.
  for (const s of SECTIONS.filter((s) => s !== "agents" && s !== "delegation")) {
    assert.match(filtered[s], /agent = @agent/, `${s} lacks agent param`);
  }
});

test("schema aliases cover both producers (canonical ADK + tracing plugin)", () => {
  assert.match(MODEL_EXPR, /\$\.model'/);
  assert.match(MODEL_EXPR, /\$\.model_version/);
  assert.match(PROMPT_TOK_EXPR, /prompt_tokens/);
  assert.match(PROMPT_TOK_EXPR, /prompt_token_count/);
  assert.match(COMPLETION_TOK_EXPR, /completion_tokens/);
  assert.match(COMPLETION_TOK_EXPR, /candidates_token_count/);
});

test("tool stats include separate TOOL_ERROR failure events", () => {
  assert.match(sql.tools, /'TOOL_COMPLETED', 'TOOL_ERROR'/);
  assert.match(sql.tools, /event_type = 'TOOL_ERROR'/);
});

test("model comparison includes canonical LLM_ERROR events", () => {
  assert.match(sql.models, /'LLM_RESPONSE', 'LLM_ERROR'/);
  assert.match(sql.models, /event_type = 'LLM_ERROR'/);
  // latency/token averages must come from successful responses only
  assert.match(sql.models, /IF\(event_type = 'LLM_RESPONSE'/);
});

test("top sessions expose drillable trace ids", () => {
  assert.match(sql.sessions, /ARRAY_AGG\(DISTINCT trace_id IGNORE NULLS LIMIT 3\)/);
});

test("granularity switches the bucket truncation", () => {
  const hourly = buildDashboardSql({ table: "`p.d.t`", granularity: "hour", agentFilter: false });
  assert.match(hourly.timeseries, /TIMESTAMP_TRUNC\(timestamp, HOUR\)/);
  assert.match(sql.timeseries, /TIMESTAMP_TRUNC\(timestamp, DAY\)/);
});

test("trace query is parameterized and time-bounded", () => {
  const t = buildTraceSql("`p.d.t`");
  assert.match(t, /trace_id = @trace_id/);
  assert.match(t, /timestamp BETWEEN @start AND @end/);
});

// ---- widget contract (parity: measure × dimension × filters)

import { buildWidgetSql, buildErrorTracesSql, WIDGET_MEASURES, WIDGET_DIMENSIONS } from "../src/queries.js";

test("widget: unknown measure/dimension/filter is rejected", () => {
  assert.throws(() => buildWidgetSql("`p.d.t`", { measure: "nope", dimension: "time" }));
  assert.throws(() => buildWidgetSql("`p.d.t`", { measure: "events", dimension: "nope" }));
  assert.throws(() =>
    buildWidgetSql("`p.d.t`", { measure: "events", dimension: "time", filters: { evil: "x" } }),
  );
});

test("widget: filter values bind as parameters, never interpolated", () => {
  const evil = "x'; DROP TABLE users; --";
  const w = buildWidgetSql("`p.d.t`", {
    measure: "p95_latency_ms",
    dimension: "model",
    filters: { agent: evil, status: "ERROR" },
  });
  assert.ok(!w.sql.includes(evil), "filter value leaked into SQL");
  assert.match(w.sql, /agent = @f_agent/);
  assert.match(w.sql, /status = @f_status/);
  assert.equal(w.filterParams.f_agent, evil);
});

test("widget: time dimension buckets and orders by time; categorical clamps limit", () => {
  const t = buildWidgetSql("`p.d.t`", { measure: "events", dimension: "time", granularity: "hour" });
  assert.match(t.sql, /TIMESTAMP_TRUNC\(timestamp, HOUR\)/);
  assert.match(t.sql, /ORDER BY dim ASC/);
  const c = buildWidgetSql("`p.d.t`", { measure: "tool_calls", dimension: "tool", limit: 5000 });
  assert.match(c.sql, /ORDER BY value DESC/);
  assert.match(c.sql, /LIMIT 100/);
});

test("widget registries expose labels for every key", () => {
  for (const m of Object.values(WIDGET_MEASURES)) assert.ok(m.label && m.sql && m.unit);
  for (const d of Object.values(WIDGET_DIMENSIONS)) assert.ok(d.label);
});

test("dashboard includes parity sections: prev_overview, hitl, delegation", () => {
  assert.ok(SECTIONS.includes("prev_overview"));
  assert.ok(SECTIONS.includes("hitl"));
  assert.ok(SECTIONS.includes("delegation"));
  assert.match(sql.hitl, /HITL_%_REQUEST/);
  assert.match(sql.hitl, /HITL_%COMPLETED/);
  assert.match(sql.delegation, /parent_span_id = b\.span_id/);
  assert.match(sql.overview, /MAX\(timestamp\)/);
});

test("error-traces query is parameterized and errors-only", () => {
  const t = buildErrorTracesSql("`p.d.t`");
  assert.match(t, /status = 'ERROR'/);
  assert.match(t, /LIMIT @limit/);
  assert.match(t, /timestamp BETWEEN @start AND @end/);
});
