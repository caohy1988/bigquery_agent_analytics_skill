# BQAA Dashboard — MCP App

Interactive Langfuse/Arize-style observability dashboard for the
[BigQuery Agent Analytics](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK)
`agent_events` table, rendered **inside MCP hosts** (Claude / Claude Desktop,
VS Code Copilot, Goose, …) via the
[MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview).

Design/discussion: [GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK/issues/396)

Ask the host *"show me my agent dashboard"* and get four views in the chat:

| View | Contents |
|---|---|
| **Overview** | events / sessions / users / error-rate / p95 stat tiles; events & errors over time; LLM p50/p95 latency over time |
| **Latency** | p95 by agent × model bars; avg / TTFT / p50 / p95 / p99 table |
| **Tokens** | prompt vs completion stacked columns; model comparison; top sessions by tokens |
| **Tools** | succeeded/failed calls per tool; failure-rate and latency table |

Global filters (time-range presets + agent) re-query BigQuery through the
iframe → host `tools/call` bridge. Every chart has hover/keyboard tooltips and a
table fallback; light and dark themes are both first-class.

## Tools exposed

- `show_agent_dashboard(time_range_hours, agent?)` — renders the UI (declares
  `_meta.ui.resourceUri = ui://bqaa/dashboard.html`) and returns a text summary
  plus the full structured payload.
- `query_agent_metrics(time_range_hours, agent?)` — same payload, no UI; used by
  the dashboard for refresh/filtering and usable by the model for text answers.
- `get_trace(trace_id, time_range_hours)` — ordered trace reconstruction for
  drill-down.

## Run it

```bash
npm install
npm run build            # bundles the UI into dist/mcp-app.html (single file)

# Mock mode — no GCP needed (also the default when BQAA_PROJECT is unset):
BQAA_MOCK=1 npm run serve

# Against BigQuery (uses Application Default Credentials):
BQAA_PROJECT=my-project BQAA_DATASET=agent_analytics BQAA_TABLE=agent_events npm run serve
```

The MCP endpoint is `http://localhost:3001/mcp` (override with `PORT`).

| Env var | Default | Meaning |
|---|---|---|
| `BQAA_PROJECT` | — | GCP project (unset ⇒ mock mode) |
| `BQAA_DATASET` | `agent_analytics` | Dataset containing agent_events |
| `BQAA_TABLE` | `agent_events` | Event table |
| `BQAA_MOCK` | — | `1` forces deterministic sample data |
| `BQAA_MAX_BYTES_BILLED` | `2000000000` | Per-query bytes-billed cap |
| `PORT` | `3001` | HTTP port |

Guardrails: read-only parameterized `SELECT`s only, a mandatory `timestamp`
predicate so the partitioned table is never full-scanned, and
`maximumBytesBilled` on every job.

### Connect to Claude

```bash
npx cloudflared tunnel --url http://localhost:3001
```

Add the generated URL as a custom connector (Settings → Connectors → Add custom
connector), then ask Claude to show your agent dashboard.

### Deploy to Cloud Run

```bash
gcloud run deploy bqaa-dashboard --source . --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "BQAA_PROJECT=<project>,BQAA_DATASET=agent_analytics,BQAA_TABLE=agent_events"
```

Grant the runtime service account `roles/bigquery.jobUser` and
`roles/bigquery.dataViewer` (or dataset-scoped read access). The resulting
`https://….run.app/mcp` URL can be added directly as a Claude custom connector.

> **Note:** `--allow-unauthenticated` makes the MCP endpoint public — anyone
> with the URL can query the configured table's aggregates and traces. Fine for
> demo/test datasets; for production telemetry put the service behind IAP, an
> API gateway, or MCP OAuth before exposing it.

### Test without a host

- `ext-apps` basic-host: `SERVERS='["http://localhost:3001/mcp"]' npm start`
  from `ext-apps/examples/basic-host`.
- Standalone preview: open `dist/mcp-app.html` directly in a browser — it
  detects it has no host and renders the sample dataset (`#latency`, `#tokens`,
  `#tools` hashes select the initial tab).

## Layout

```
server.ts        MCP server: tools + ui:// resource + BigQuery/mock data layer
mcp-app.html     UI shell and styles (light/dark via CSS custom properties)
src/mcp-app.ts   Charts (inline SVG), tooltips, filters, host bridge
src/mock.ts      Deterministic sample data (server mock mode + standalone preview)
src/types.ts     Shared payload types
```
