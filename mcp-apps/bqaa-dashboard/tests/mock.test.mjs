// Mock-data truthfulness — filters honored, one row set drives everything (r9).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockWidget, mockAsk } from "../src/mock.js";

const start = new Date("2026-07-01T00:00:00Z");
const end = new Date("2026-07-02T00:00:00Z");

test("mockWidget honors a filter on the grouped dimension (#8-r9)", () => {
  const spec = { measure: "events", dimension: "agent", granularity: "auto", filters: { agent: "billing-agent" } };
  const r = mockWidget(spec, start, end);
  assert.equal(r.rows.length, 1, "a matching dimension filter narrows to that value");
  assert.equal(r.rows[0].dim, "billing-agent");
});

test("mockWidget seed covers filters — different filters, different data (#8-r9)", () => {
  const base = { measure: "events", dimension: "agent", granularity: "auto" };
  const a = mockWidget({ ...base, filters: {} }, start, end);
  const b = mockWidget({ ...base, filters: { tool: "search_kb" } }, start, end);
  assert.notDeepEqual(a.rows, b.rows, "a non-dimension filter must still change the sample");
});

test("mockAsk prose, rows, and SQL all come from one sorted sample (#10-r9)", () => {
  const r = mockAsk("Which tool fails most?", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-02T00:00:00Z" });
  const rates = r.rows.map((row) => row.failure_rate);
  assert.deepEqual(rates, [...rates].sort((x, y) => y - x), "rows arrive sorted by failure rate");
  const top = r.rows[0];
  assert.ok(r.answer.includes(`**${top.tool_name}**`), "prose names the actual top row");
  assert.ok(r.answer.includes(`${(top.failure_rate * 100).toFixed(1)}%`), "prose quotes the actual top rate");
  assert.match(r.sql, /SELECT tool_name, starting_count, error_count, error_count \/ starting_count AS failure_rate/);
});

test("mockAsk escapes a hostile agent value in the sample SQL (#9-r9)", () => {
  const r = mockAsk("q", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-02T00:00:00Z", agent: "x' OR '1'='1" });
  assert.ok(!r.sql.includes("agent = 'x' OR '1'='1'"), "raw interpolation would break out of the literal");
  assert.ok(r.sql.includes("agent = 'x\\' OR \\'1\\'=\\'1'"), "value is escaped as one literal");
});
