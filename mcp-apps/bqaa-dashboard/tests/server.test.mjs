// Integration tests: spawn the real server (mock data mode) and exercise the
// HTTP + MCP surfaces, including auth, Origin policy, and config validation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer(env, port) {
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: root,
    env: { ...process.env, BQAA_MOCK: "1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return { child, logs: () => logs };
}

async function waitFor(url, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function rpc(base, method, params, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const PORT = 3800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
let main;

before(async () => {
  main = startServer({}, PORT);
  await waitFor(`${BASE}/healthz`);
});

after(() => {
  main?.child.kill();
});

test("healthz reports ok and mock mode", async () => {
  const res = await fetch(`${BASE}/healthz`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mock, true);
});

test("root serves the dashboard shell", async () => {
  const res = await fetch(BASE);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Agent Analytics/);
});

test("/api/dashboard returns the full payload and clamps hours", async () => {
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=999999`);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.ok(data.overview);
  assert.ok(Array.isArray(data.timeseries));
  assert.ok(Array.isArray(data.topSessions));
  assert.ok(data.topSessions[0].trace_ids?.length, "sessions must carry drillable trace ids");
  const hours = (Date.parse(data.meta.end) - Date.parse(data.meta.start)) / 3_600_000;
  assert.ok(hours <= 2160 + 1, `hours clamped, got ${hours}`);
});

test("/api/trace validates trace_id and returns events", async () => {
  const bad = await fetch(`${BASE}/api/trace?trace_id=;drop`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${BASE}/api/trace?trace_id=abcd1234abcd1234`);
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.ok(Array.isArray(data) && data.length > 0);
  assert.ok(data[0].event_type);
});

test("MCP initialize, tools/list, tools/call, resources/read", async () => {
  const init = await rpc(BASE, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.status, 200);

  const tools = await rpc(BASE, "tools/list", {});
  const names = tools.body.result.tools.map((t) => t.name);
  for (const expected of ["get_trace", "query_agent_metrics", "show_agent_dashboard", "query_widget", "render_widget", "list_error_traces"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const dash = tools.body.result.tools.find((t) => t.name === "show_agent_dashboard");
  assert.equal(dash._meta?.ui?.resourceUri, "ui://bqaa/dashboard.html");

  const call = await rpc(BASE, "tools/call", {
    name: "query_agent_metrics",
    arguments: { time_range_hours: 24 },
  });
  assert.ok(call.body.result.structuredContent?.data?.overview);

  const res = await rpc(BASE, "resources/read", { uri: "ui://bqaa/dashboard.html" });
  assert.match(res.body.result.contents[0].mimeType, /^text\/html/);
});

test("MCP rejects invalid tool arguments", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "query_agent_metrics",
    arguments: { time_range_hours: 0 },
  });
  const failed = call.body.error != null || call.body.result?.isError === true;
  assert.ok(failed, "expected an error for out-of-range hours");
});

test("bearer auth guards data endpoints when configured", async () => {
  const port = PORT + 100;
  const srv = startServer({ BQAA_AUTH_TOKEN: "s3cret" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const noAuth = await fetch(`http://localhost:${port}/api/dashboard`);
    assert.equal(noAuth.status, 401);
    const mcpNoAuth = await rpc(`http://localhost:${port}`, "tools/list", {});
    assert.equal(mcpNoAuth.status, 401);
    const withAuth = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    assert.equal(withAuth.status, 200);
    // page shell stays reachable without auth (it holds no data)
    const page = await fetch(`http://localhost:${port}/`);
    assert.equal(page.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("cross-origin requests require an allowlisted Origin", async () => {
  const port = PORT + 101;
  const srv = startServer({ BQAA_ALLOWED_ORIGINS: "https://ok.example" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const evil = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
    const ok = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Origin: "https://ok.example" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://ok.example");
    // no Origin header (server-to-server) passes
    const plain = await fetch(`http://localhost:${port}/api/dashboard`);
    assert.equal(plain.status, 200);
    // same-origin requests always pass (browsers send Origin on POSTs)
    const sameOrigin = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Origin: `http://localhost:${port}` },
    });
    assert.equal(sameOrigin.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("invalid BQAA_DEFAULT_HOURS fails fast at startup", async () => {
  const srv = startServer({ BQAA_DEFAULT_HOURS: "abc" }, PORT + 102);
  const code = await new Promise((resolve) => srv.child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(srv.logs(), /Invalid BQAA_DEFAULT_HOURS/);
});

// ---- parity + differentiator surfaces

test("/api/widget runs a widget and validates inputs", async () => {
  const bad = await fetch(`${BASE}/api/widget?measure=nope&dimension=time`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${BASE}/api/widget?measure=events&dimension=agent&time_range_hours=24`);
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.equal(data.spec.measure, "events");
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0);
  assert.ok(data.rows[0].dim != null);
});

test("/api/widget dry_run returns an estimate and no rows", async () => {
  const res = await fetch(`${BASE}/api/widget?measure=total_tokens&dimension=model&dry_run=1`);
  const { data } = await res.json();
  assert.equal(data.dry_run, true);
  assert.equal(data.rows.length, 0);
  assert.ok(data.estimated_bytes > 0);
});

test("dashboard payload includes prev_overview, hitl, delegation, freshness", async () => {
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=24`);
  const { data } = await res.json();
  assert.ok(data.prevOverview?.total_events > 0);
  assert.ok(Array.isArray(data.hitl) && data.hitl.length > 0);
  assert.ok(Array.isArray(data.delegation) && data.delegation.length > 0);
  assert.ok(data.overview.last_event_ts);
});

test("MCP exposes widget + error-trace tools; render_widget carries UI meta", async () => {
  const tools = await rpc(BASE, "tools/list", {});
  const byName = Object.fromEntries(tools.body.result.tools.map((t) => [t.name, t]));
  assert.ok(byName.query_widget);
  assert.ok(byName.list_error_traces);
  assert.equal(byName.render_widget?._meta?.ui?.resourceUri, "ui://bqaa/dashboard.html");

  const call = await rpc(BASE, "tools/call", {
    name: "query_widget",
    arguments: { measure: "p95_latency_ms", dimension: "agent", time_range_hours: 24 },
  });
  assert.ok(call.body.result.structuredContent?.data?.rows?.length > 0);

  const traces = await rpc(BASE, "tools/call", { name: "list_error_traces", arguments: {} });
  assert.ok(traces.body.result.structuredContent?.data?.length > 0);
  assert.match(traces.body.result.content[0].text, /trace/);
});

test("/api/ask answers via the conversational layer (mock) and validates input", async () => {
  const bad = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "hi" }),
  });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Which tool fails most?" }),
  });
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.ok(data.answer.length > 10);
  assert.ok(data.sql);
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0);
});

test("MCP ask_data tool answers questions", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "ask_data",
    arguments: { question: "Which tool fails most?" },
  });
  const d = call.body.result.structuredContent?.data;
  assert.ok(d?.answer);
  assert.match(call.body.result.content[0].text, /failure|fail/i);
});
