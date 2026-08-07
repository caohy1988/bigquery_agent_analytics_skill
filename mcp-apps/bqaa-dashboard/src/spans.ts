// Span reconstruction for the trace waterfall — pure and browser-safe, so the
// pairing/hierarchy rules are unit-testable without a DOM.
//
// agent_events logs spans as event pairs: TOOL_STARTING → TOOL_COMPLETED /
// TOOL_ERROR, LLM_REQUEST → LLM_RESPONSE / LLM_ERROR, sharing a span_id. Some
// producers log only the completion event with latency_ms; some events have
// no span at all. All three shapes must render truthfully.

import type { TraceEvent } from "./types.js";

export type SpanKind = "llm" | "tool" | "other";

export interface TraceSpan {
  id: string | null;
  name: string;
  kind: SpanKind;
  agent: string | null;
  startMs: number; // relative to trace start
  endMs: number;
  depth: number; // parent-chain nesting, capped
  error: boolean;
  instant: boolean; // no measurable duration — render as a point marker
  detail: string; // tooltip line: origin / error message / response snippet
}

const MAX_DEPTH = 6;
const START_TYPES = /(_STARTING|_REQUEST)$/;

function isErrorEvent(e: TraceEvent): boolean {
  return e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null;
}

function kindOf(eventTypes: string[]): SpanKind {
  if (eventTypes.some((t) => t.startsWith("LLM"))) return "llm";
  if (eventTypes.some((t) => t.startsWith("TOOL"))) return "tool";
  return "other";
}

export function buildSpans(events: TraceEvent[]): { spans: TraceSpan[]; totalMs: number } {
  if (!events.length) return { spans: [], totalMs: 0 };
  const t0 = Math.min(...events.map((e) => Date.parse(e.timestamp)));

  // group by span_id; span-less events become their own instant rows
  const groups = new Map<string, TraceEvent[]>();
  const orphans: TraceEvent[] = [];
  for (const e of events) {
    if (e.span_id) {
      const g = groups.get(e.span_id) ?? [];
      g.push(e);
      groups.set(e.span_id, g);
    } else {
      orphans.push(e);
    }
  }

  // parent map for depth resolution
  const parentOf = new Map<string, string | null>();
  for (const [id, g] of groups) {
    parentOf.set(id, g.find((e) => e.parent_span_id)?.parent_span_id ?? null);
  }
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const parent = parentOf.get(id);
    if (!parent || !groups.has(parent) || seen.has(id) || seen.size >= MAX_DEPTH) return 0;
    seen.add(id);
    return Math.min(MAX_DEPTH, 1 + depthOf(parent, seen));
  };

  const spans: TraceSpan[] = [];
  for (const [id, g] of groups) {
    const times = g.map((e) => Date.parse(e.timestamp));
    const starts = g.filter((e) => START_TYPES.test(e.event_type));
    const latency = g.map((e) => e.latency_ms).find((l) => l != null) ?? null;
    let startMs: number;
    let endMs: number;
    if (starts.length) {
      startMs = Math.min(...starts.map((e) => Date.parse(e.timestamp))) - t0;
      endMs = Math.max(...times) - t0;
    } else if (latency != null) {
      // completion-only logging: the event marks the END of the span
      endMs = Math.max(...times) - t0;
      startMs = Math.max(0, endMs - latency);
    } else {
      startMs = Math.min(...times) - t0;
      endMs = startMs;
    }
    const types = g.map((e) => e.event_type);
    const kind = kindOf(types);
    const tool = g.map((e) => e.tool_name).find(Boolean) ?? null;
    const err = g.find(isErrorEvent);
    spans.push({
      id,
      name: tool ?? (kind === "llm" ? "LLM call" : types[0]),
      kind,
      agent: g.map((e) => e.agent).find(Boolean) ?? null,
      startMs,
      endMs: Math.max(endMs, startMs),
      depth: depthOf(id),
      error: !!err,
      instant: endMs <= startMs,
      detail:
        err?.error_message ??
        g.map((e) => e.tool_origin).find(Boolean) ??
        g.map((e) => e.llm_response).find(Boolean)?.slice(0, 120) ??
        "",
    });
  }
  for (const e of orphans) {
    const at = Date.parse(e.timestamp) - t0;
    spans.push({
      id: null,
      name: e.tool_name ?? e.event_type,
      kind: kindOf([e.event_type]),
      agent: e.agent,
      startMs: at,
      endMs: e.latency_ms != null ? at : at,
      depth: 0,
      error: isErrorEvent(e),
      instant: true,
      detail: e.error_message ?? "",
    });
  }

  spans.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const totalMs = Math.max(1, ...spans.map((s) => s.endMs), Math.max(...events.map((e) => Date.parse(e.timestamp))) - t0);
  return { spans, totalMs };
}
