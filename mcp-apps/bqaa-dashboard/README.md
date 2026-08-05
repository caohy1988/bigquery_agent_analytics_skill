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
iframe → host `tools/call` bridge. Every chart has hover/keyboard tooltips and
an accessible "Show data" table; top sessions drill down to a full trace
timeline (`get_trace`). Light and dark themes are both first-class.

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
| `BQAA_MAX_BYTES_BILLED` | `2000000000` | Bytes-billed budget for **one dashboard refresh** (split across its queries) |
| `BQAA_DEFAULT_HOURS` | `168` | Default lookback window in hours (1–2160); validated at startup |
| `BQAA_AUTH_TOKEN` | — | If set, `/mcp` and `/api/*` require `Authorization: Bearer <token>` (browser pages may pass `?token=`) |
| `BQAA_ALLOWED_ORIGINS` | — | Comma-separated Origin allowlist (or `*`). Unset ⇒ same-origin only: cross-origin requests are refused |
| `PORT` | `3001` | HTTP port |

Guardrails: read-only parameterized `SELECT`s only, a mandatory `timestamp`
predicate so the partitioned table is never full-scanned, a per-refresh
`maximumBytesBilled` budget, a 60 s result cache with concurrent-request
coalescing, and partial-failure handling (one failed panel query is reported in
`meta.section_errors` instead of blanking the dashboard). The footer shows
bytes scanned per refresh. `GET /api/health` reports readiness (`/healthz`
works locally but is intercepted by Google Frontend on run.app); requests are
logged as structured JSON.

### Connect to Claude

```bash
npx cloudflared tunnel --url http://localhost:3001
```

Add the generated URL as a custom connector (Settings → Connectors → Add custom
connector), then ask Claude to show your agent dashboard.

### Deploy to Cloud Run

Private (IAM-authenticated) deployment is the default posture:

```bash
gcloud run deploy bqaa-dashboard --source . --region us-central1 \
  --no-allow-unauthenticated \
  --set-env-vars "BQAA_PROJECT=<project>,BQAA_DATASET=agent_analytics,BQAA_TABLE=agent_events"
```

Grant the runtime service account `roles/bigquery.jobUser` and
`roles/bigquery.dataViewer` (or dataset-scoped read access). Reach a private
service through an identity-aware proxy / `gcloud run services proxy`, or grant
`roles/run.invoker` to specific members.

For a **demo on a test dataset only**, you can expose it publicly — combine
`--allow-unauthenticated` with the app-level guards:

```bash
gcloud run deploy bqaa-dashboard --source . --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "BQAA_PROJECT=<project>,BQAA_DATASET=<demo_dataset>,BQAA_TABLE=agent_events,BQAA_AUTH_TOKEN=<random-token>,BQAA_ALLOWED_ORIGINS=*"
```

The `https://….run.app/mcp` URL can then be added as a Claude custom connector.
Anyone with the URL + token can query the configured table's aggregates and
traces — never point a public deployment at production telemetry.

### Test without a host

- `ext-apps` basic-host: `SERVERS='["http://localhost:3001/mcp"]' npm start`
  from `ext-apps/examples/basic-host`.
- Standalone preview: open `dist/mcp-app.html` directly in a browser — it
  detects it has no host and renders the sample dataset (`#latency`, `#tokens`,
  `#tools` hashes select the initial tab).

## Tests

```bash
npm test
```

Runs the SQL contract tests (schema aliases for both producers, `LLM_ERROR` /
`TOOL_ERROR` inclusion, partition predicates, parameterization) and an
integration suite that boots the server in mock mode and exercises `/healthz`,
`/`, `/api/dashboard`, `/api/trace`, the MCP JSON-RPC surface, invalid
arguments, bearer auth, the Origin allowlist, and startup config validation.

## Layout

```
server.ts        MCP server: tools + ui:// resource + auth/origin/budget guards
src/queries.ts   SQL contract (pure builders — unit-testable, shareable)
mcp-app.html     UI shell (design system in src/styles.css)
src/mcp-app.ts   Charts (inline SVG), tooltips, filters, drill-down, host bridge
src/mock.ts      Deterministic sample data (server mock mode + file:// preview)
src/types.ts     Shared payload types
tests/           Contract + integration tests (`npm test`)
```

## Credits

UI type: [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) (OFL), embedded in the bundle so it renders under the MCP-app CSP.
