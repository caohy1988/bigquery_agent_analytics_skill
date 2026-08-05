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
  for (const s of SECTIONS.filter((s) => s !== "agents")) {
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
