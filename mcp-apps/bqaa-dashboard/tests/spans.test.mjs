// Waterfall span-reconstruction rules — pairing, latency fallback, hierarchy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSpans } from "../src/spans.js";

const ev = (over) => ({
  timestamp: "2026-08-07T00:00:00Z", event_type: "TOOL_STARTING", agent: "a1",
  invocation_id: null, span_id: null, parent_span_id: null, llm_response: null,
  tool_name: null, tool_origin: null, latency_ms: null, status: "OK", error_message: null,
  ...over,
});

test("start/complete pairs become one span with the right duration", () => {
  const { spans, totalMs } = buildSpans([
    ev({ span_id: "s1", event_type: "TOOL_STARTING", tool_name: "search_kb", timestamp: "2026-08-07T00:00:01Z" }),
    ev({ span_id: "s1", event_type: "TOOL_COMPLETED", tool_name: "search_kb", timestamp: "2026-08-07T00:00:03Z", latency_ms: 2000 }),
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "search_kb");
  assert.equal(spans[0].kind, "tool");
  assert.equal(spans[0].endMs - spans[0].startMs, 2000);
  assert.equal(spans[0].instant, false);
  assert.equal(totalMs, 2000); // trace time starts at the EARLIEST event (:01), not :00
});

test("completion-only logging back-computes the start from latency", () => {
  const { spans } = buildSpans([
    ev({ event_type: "LLM_REQUEST", span_id: "root", timestamp: "2026-08-07T00:00:00Z" }),
    ev({ span_id: "L2", event_type: "LLM_RESPONSE", timestamp: "2026-08-07T00:00:05Z", latency_ms: 1500 }),
  ]);
  const llm = spans.find((s) => s.id === "L2");
  assert.equal(llm.startMs, 3500);
  assert.equal(llm.endMs, 5000);
  assert.equal(llm.name, "LLM call");
});

test("parent chains produce depth; cycles and missing parents stay at 0", () => {
  const { spans } = buildSpans([
    ev({ span_id: "root", event_type: "LLM_REQUEST" }),
    ev({ span_id: "child", parent_span_id: "root", event_type: "TOOL_STARTING", tool_name: "t", timestamp: "2026-08-07T00:00:01Z" }),
    ev({ span_id: "grand", parent_span_id: "child", event_type: "TOOL_STARTING", tool_name: "g", timestamp: "2026-08-07T00:00:02Z" }),
    ev({ span_id: "lost", parent_span_id: "nonexistent", event_type: "TOOL_STARTING", tool_name: "l", timestamp: "2026-08-07T00:00:03Z" }),
  ]);
  const by = Object.fromEntries(spans.map((s) => [s.id, s.depth]));
  assert.equal(by.root, 0);
  assert.equal(by.child, 1);
  assert.equal(by.grand, 2);
  assert.equal(by.lost, 0);
});

test("errors mark the span; span-less events render as instants", () => {
  const { spans } = buildSpans([
    ev({ span_id: "s1", event_type: "TOOL_STARTING", tool_name: "x" }),
    ev({ span_id: "s1", event_type: "TOOL_ERROR", tool_name: "x", timestamp: "2026-08-07T00:00:02Z", status: "ERROR", error_message: "boom" }),
    ev({ event_type: "USER_MESSAGE_RECEIVED", timestamp: "2026-08-07T00:00:00Z" }),
  ]);
  const s1 = spans.find((s) => s.id === "s1");
  assert.equal(s1.error, true);
  assert.equal(s1.detail, "boom");
  const orphan = spans.find((s) => s.id === null);
  assert.equal(orphan.instant, true);
  assert.equal(orphan.name, "USER_MESSAGE_RECEIVED");
});

test("spans sort by start time and empty input is safe", () => {
  assert.deepEqual(buildSpans([]), { spans: [], totalMs: 0 });
  const { spans } = buildSpans([
    ev({ span_id: "b", event_type: "TOOL_STARTING", tool_name: "later", timestamp: "2026-08-07T00:00:05Z" }),
    ev({ span_id: "a", event_type: "TOOL_STARTING", tool_name: "earlier", timestamp: "2026-08-07T00:00:01Z" }),
  ]);
  assert.deepEqual(spans.map((s) => s.name), ["earlier", "later"]);
});
