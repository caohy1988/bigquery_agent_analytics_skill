# Failure Patterns

After completing the Survey/Filter/Deep Dive analysis, check if results
match any pattern below. State which pattern matched and the recommended
next step.

| Signal | Likely Cause | Diagnostic Next Step |
|--------|-------------|---------------------|
| p95_latency high + total_tokens low | Tool call overhead or cold starts | `tool_calls` CTE: `AVG(tool_latency_ms) GROUP BY tool_name` |
| error_rate spikes on one model_id | Model version regression or prompt schema drift | `llm_responses` CTE: error rate `GROUP BY model_id` |
| prompt_tokens growing over time | System prompt bloat or unbounded context accumulation | `llm_responses` CTE: `AVG(prompt_tokens)` by `DATE(timestamp)` |
| tool failures on one tool_origin only | Custom tool bug (not a platform issue) | `tool_calls` CTE: fail rate `GROUP BY tool_origin, tool_name` |
| High HITL event count | Agent asking too many confirmations | `COUNT(*) WHERE event_type LIKE 'HITL_%' GROUP BY agent` |
| session duration_sec very high, few events | Long HITL waits or rate limiting | `sessions` CTE: compare `duration_sec` vs `total_events` |
| agent_tree shows A->B->A cycles | Delegation loop — recursive agent calls | `agent_tree` CTE: detect bidirectional edges |
| TTFT high but total latency normal | Model queue time / cold start | `llm_responses` CTE: `AVG(ttft_ms)` vs `AVG(total_latency_ms)` by hour |
| is_truncated = true on error events | Error context cut off | Check `content_parts[].object_ref.uri` for GCS fallback |
| Sudden drop in total event count | Instrumentation broke, not fewer calls | Check if specific `agent` values disappeared from recent data |
| error_rate normal, p50_latency creeping up | Queue saturation or rate limiting | Check latency correlation with time-of-day |
