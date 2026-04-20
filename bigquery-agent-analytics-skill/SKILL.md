---
name: bigquery-agent-analytics-skill
description: >
  Analyze BigQuery Agent Analytics (BQAA) data — error rates, latency
  analysis, token usage trends, tool failure rates, agent delegation flows,
  HITL bottlenecks, model comparison, and session token usage for cost
  estimation. Use when the user asks about agent performance, debugging,
  cost analysis, or observability from a BQAA agent_events table.
license: MIT
compatibility: Requires Python 3.9+ and google-cloud-bigquery package
metadata:
  author: Erroration2022
  version: "2.1"
allowed-tools: Bash(python scripts/run_bq.py:*)
---

## Gotchas

- The `content` column is **polymorphic** — its JSON structure changes per
  `event_type`. Always filter by `event_type` before extracting content fields.
- `latency_ms` is a JSON column, not a number. Extract via
  `JSON_VALUE(latency_ms, '$.total_ms')` and CAST to FLOAT64.
- `parent_span_id` self-joins **must match on both `span_id` AND `trace_id`**.
  Omitting `trace_id` produces cross-trace garbage joins.
- The table is partitioned on `timestamp`. Forgetting a `WHERE timestamp`
  filter can scan terabytes. Always include a date range — even when
  filtering on `trace_id`, also bracket the trace with `@start`/`@end`.
- `is_truncated = true` means the content was cut off — check
  `content_parts[].object_ref.uri` for the full payload in GCS.

## Execution

`scripts/run_bq.py` is the **only** script to invoke during analysis.
`scripts/compile.py` is a build-time helper that inlines all references
into a single file for clients without progressive disclosure — never
run it as part of a user-facing analysis task.

ALWAYS execute queries via the helper script. It auto-injects `{PROJECT}`,
`{DATASET}`, and `{TABLE}` from environment variables (`GCP_PROJECT_ID`,
`BQ_DATASET`, `BQ_TABLE`) — never ask the user for their project or
dataset name.

**Working directory:** invoke the script by its path relative to the skill
root (shown below as `scripts/run_bq.py`). If the agent's current working
directory is not the skill root, substitute the absolute path to the
script — it has no runtime dependency on CWD.

Query parameters `@start`, `@end`, and `@trace_id` are bound via CLI flags
(not string substitution) so BigQuery's parameterized-query safety holds:

```bash
python scripts/run_bq.py \
  --start 2026-04-01 --end 2026-04-15 \
  "SELECT ... FROM \`{PROJECT}.{DATASET}.{TABLE}\` WHERE timestamp BETWEEN @start AND @end"
```

For trace reconstruction, also pass `--trace-id` (and still keep a time
window so partition pruning kicks in):

```bash
python scripts/run_bq.py --start 2026-04-10 --end 2026-04-11 \
  --trace-id abc123... "SELECT ... WHERE trace_id = @trace_id AND timestamp BETWEEN @start AND @end"
```

**CRITICAL — dry-run every query before executing:**

```bash
python scripts/run_bq.py --dry-run --start ... --end ... "YOUR SQL"
```

- [ ] Run dry-run
- [ ] Check output: if `exceeds_limit` is `true`, tighten date filter and retry
- [ ] Only execute after dry-run confirms scan < 1 GB

## Methodology

For investigations driven by a reported issue ("errors are up", "this
session was slow"), follow Survey → Filter → Deep Dive → Diagnose in
order. For exploratory or comparative questions (model comparison,
delegation visualization, token-trend rollups) skip straight to the
matching ready-made query in [references/queries.md](references/queries.md).

Default flow when an issue is implied:

- [ ] **Step 1 — Survey:** Count total events, errors, error rate, unique agents,
  and p95 latency in the time window. Present as a one-line summary. If no issues,
  tell the user and stop.
- [ ] **Step 2 — Filter:** Isolate the top 3 contributors. Read
  [references/ctes.md](references/ctes.md) and use the appropriate CTE
  (`llm_responses` for token/latency, `tool_calls` for tools, `errors` for
  failures). Present as a markdown table, max 3 rows.
- [ ] **Step 3 — Deep Dive:** Extract the full trace for one representative
  failure from the top offender. Present chronologically with a plain-english
  walkthrough.
- [ ] **Diagnose:** Read [references/failure-patterns.md](references/failure-patterns.md)
  and map results to a known pattern. State: "This matches pattern: [X].
  Recommended next step: [Y]."

For non-investigative requests (e.g. "compare models this month", "show
delegation for trace X", "token usage trend this week"), run the
matching query directly and present in the format dictated under
**Output** — no mandatory Survey/Filter/Deep Dive.

## CTE Rule

BQAA JSON paths are deeply nested. **Never write raw `JSON_VALUE()` or
`JSON_EXTRACT()` from scratch.** Always start queries with a base CTE from
[references/ctes.md](references/ctes.md). Use the default `llm_responses`
CTE unless the question is specifically about tools or delegation.

## Output

- **Survey** — single summary line
- **Filter** — markdown table, max 3 rows, sorted by problem metric
- **Deep Dive** — chronological code block + plain-english walkthrough
- **Delegation queries** — render as Mermaid `sequenceDiagram`
  (see [assets/mermaid-template.md](assets/mermaid-template.md))
- **Model comparison** — markdown table sorted by `avg_latency_ms` descending
- **Session token usage** — markdown table sorted by `total_tokens` descending;
  note that cost projections require applying current per-model prices
- When diagnosing an investigation, end with the matched failure pattern
  + recommended next action

## References (load on demand)

| File | When to load |
|------|-------------|
| [references/schema.md](references/schema.md) | When you need column types or nested field paths |
| [references/ctes.md](references/ctes.md) | When writing any query (pick the right CTE) |
| [references/queries.md](references/queries.md) | When a ready-made query matches the user's question |
| [references/failure-patterns.md](references/failure-patterns.md) | After Step 3, to diagnose results |
| [references/examples.md](references/examples.md) | If unsure how to structure the end-to-end flow |
