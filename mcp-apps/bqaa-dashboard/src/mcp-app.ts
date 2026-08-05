// BQAA Dashboard MCP App — UI.
// Renders inside an MCP host iframe (Claude, Goose, basic-host, …) and talks to
// the server via the ext-apps bridge. Standalone (opened directly in a browser)
// it falls back to the deterministic mock dataset for preview/QA.

import "./styles.css";
import { App } from "@modelcontextprotocol/ext-apps";
import { mockDashboard, mockTrace } from "./mock.js";
import type { DashboardData, TimeBucket, TraceEvent } from "./types.js";

// Optional bearer token for servers started with BQAA_AUTH_TOKEN, supplied to
// the shared page as ?token=… (or #token=…).
const AUTH_TOKEN =
  new URLSearchParams(location.search).get("token") ??
  new URLSearchParams(location.hash.replace(/^#/, "")).get("token") ??
  "";

function authHeaders(): Record<string, string> {
  return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};
}

// ---------------------------------------------------------------- formatting

const fmtInt = (v: number | null | undefined): string =>
  v == null ? "—" : Math.round(v).toLocaleString("en-US");

const fmtCompact = (v: number | null | undefined): string => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
};

const fmtMs = (v: number | null | undefined): string => {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
  return `${(v / 60_000).toFixed(1)} min`;
};

const fmtPct = (v: number | null | undefined): string => (v == null ? "—" : `${v}%`);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function bucketLabel(iso: string, granularity: "hour" | "day"): string {
  const d = new Date(iso);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (granularity === "day") return md;
  return `${md}, ${String(d.getHours()).padStart(2, "0")}:00`;
}

// ---------------------------------------------------------------- DOM utils

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const NS = "http://www.w3.org/2000/svg";
function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

// ---------------------------------------------------------------- tooltip

const tooltipEl = document.getElementById("tooltip") as HTMLDivElement;

interface TooltipRow {
  name: string;
  value: string;
  cssVar?: string;
}

function showTooltip(title: string, rows: TooltipRow[], clientX: number, clientY: number): void {
  tooltipEl.replaceChildren();
  tooltipEl.appendChild(el("div", "tt-title", title));
  for (const r of rows) {
    const row = el("div", "tt-row");
    const key = el("span", "tt-key");
    key.style.background = r.cssVar ? `var(${r.cssVar})` : "transparent";
    row.appendChild(key);
    row.appendChild(el("span", "tt-val", r.value));
    row.appendChild(el("span", "tt-name", r.name));
    tooltipEl.appendChild(row);
  }
  tooltipEl.hidden = false;
  const rect = tooltipEl.getBoundingClientRect();
  let x = clientX + 14;
  let y = clientY + 14;
  if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - 14;
  tooltipEl.style.left = `${Math.max(4, x)}px`;
  tooltipEl.style.top = `${Math.max(4, y)}px`;
}

function hideTooltip(): void {
  tooltipEl.hidden = true;
}

// ---------------------------------------------------------------- scales

function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

// ---------------------------------------------------------------- line chart

interface LineSeries {
  name: string;
  cssVar: string;
  values: Array<number | null>;
}

function lineChart(
  container: HTMLElement,
  buckets: TimeBucket[],
  series: LineSeries[],
  opts: {
    yFmt: (v: number | null) => string;
    granularity: "hour" | "day";
    height?: number;
    ariaLabel: string;
    areaFirst?: boolean; // ~10% wash under the first series
    sectionError?: string;
  },
): void {
  const H = opts.height ?? 236;
  const W = Math.max(280, container.clientWidth || 560);
  const n = buckets.length;
  if (n === 0) {
    emptyNote(container, opts.sectionError);
    return;
  }

  const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))));
  // left margin sized to the widest y-tick label so units like "16.7 min" fit
  const TICKS = 4;
  const tickLabels = Array.from({ length: TICKS }, (_, k) => opts.yFmt((maxVal / TICKS) * (k + 1)));
  const m = {
    top: 10,
    right: 46,
    bottom: 22,
    left: Math.max(40, 12 + Math.max(...tickLabels.map((t) => t.length)) * 6.6),
  };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });

  const x = (i: number) => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v: number) => m.top + ph - (v / maxVal) * ph;

  // gridlines + y ticks (clean numbers)
  for (let t = 1; t <= TICKS; t++) {
    const v = (maxVal / TICKS) * t;
    const gy = y(v);
    const line = svgEl("line", { x1: m.left, x2: m.left + pw, y1: gy, y2: gy });
    line.setAttribute("class", "gridline");
    svg.appendChild(line);
    const label = svgEl("text", { x: m.left - 6, y: gy + 3, "text-anchor": "end" });
    label.textContent = tickLabels[t - 1];
    svg.appendChild(label);
  }
  const base = svgEl("line", { x1: m.left, x2: m.left + pw, y1: m.top + ph, y2: m.top + ph });
  base.setAttribute("class", "baseline");
  svg.appendChild(base);

  // x ticks — at most 6
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    const label = svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" });
    label.textContent = bucketLabel(buckets[i].ts, opts.granularity);
    svg.appendChild(label);
  }

  // series paths, end dots, selective end labels
  const endLabelYs: number[] = [];
  series.forEach((s, si) => {
    let d = "";
    let pen = false;
    let firstIdx = -1;
    let lastIdx = -1;
    s.values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d && si === 0 && opts.areaFirst && firstIdx >= 0 && lastIdx > firstIdx) {
      const wash = svgEl("path", {
        d: `${d}L${x(lastIdx).toFixed(1)},${(m.top + ph).toFixed(1)}L${x(firstIdx).toFixed(1)},${(m.top + ph).toFixed(1)}Z`,
      });
      wash.style.fill = "var(--wash)";
      svg.appendChild(wash);
    }
    if (d) {
      const path = svgEl("path", {
        d,
        fill: "none",
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      });
      path.style.stroke = `var(${s.cssVar})`;
      svg.appendChild(path);
    }
    let last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (s.values[i] != null) {
        last = i;
        break;
      }
    }
    if (last >= 0) {
      const vy = y(s.values[last] as number);
      const dot = svgEl("circle", { cx: x(last), cy: vy, r: 4, "stroke-width": 2 });
      dot.style.fill = `var(${s.cssVar})`;
      dot.style.stroke = "var(--surface-1)";
      svg.appendChild(dot);
      // end label only when it won't collide with an earlier series' label
      if (!endLabelYs.some((py) => Math.abs(py - vy) < 13)) {
        endLabelYs.push(vy);
        const label = svgEl("text", { x: x(last) + 8, y: vy + 3 });
        label.textContent = opts.yFmt(s.values[last]);
        label.style.fill = "var(--ink-2)";
        svg.appendChild(label);
      }
    }
  });

  // crosshair + hover/focus layer
  const cross = svgEl("line", { y1: m.top, y2: m.top + ph, x1: 0, x2: 0, visibility: "hidden" });
  cross.setAttribute("class", "crosshair");
  svg.appendChild(cross);

  const overlay = svgEl("rect", {
    x: m.left,
    y: m.top,
    width: pw,
    height: ph,
    fill: "transparent",
    tabindex: 0,
  });
  overlay.setAttribute("class", "hit-overlay");
  let focusIdx = n - 1;

  const present = (i: number, cx: number, cy: number) => {
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    showTooltip(
      bucketLabel(buckets[i].ts, opts.granularity),
      series.map((s) => ({ name: s.name, value: opts.yFmt(s.values[i]), cssVar: s.cssVar })),
      cx,
      cy,
    );
  };
  overlay.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left - m.left;
    const i = Math.max(0, Math.min(n - 1, Math.round((px / pw) * (n - 1))));
    focusIdx = i;
    present(i, e.clientX, e.clientY);
  });
  overlay.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  const presentFocus = () => {
    const rect = svg.getBoundingClientRect();
    present(focusIdx, rect.left + x(focusIdx), rect.top + m.top + ph / 2);
  };
  overlay.addEventListener("focus", presentFocus);
  overlay.addEventListener("blur", () => {
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") focusIdx = Math.max(0, focusIdx - 1);
    else if (e.key === "ArrowRight") focusIdx = Math.min(n - 1, focusIdx + 1);
    else return;
    e.preventDefault();
    presentFocus();
  });
  svg.appendChild(overlay);
  container.appendChild(svg);
}

// ------------------------------------------------------------ stacked columns

interface ColumnSegment {
  name: string;
  cssVar: string;
  values: number[];
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function stackedColumns(
  container: HTMLElement,
  buckets: TimeBucket[],
  segments: ColumnSegment[],
  opts: {
    yFmt: (v: number | null) => string;
    granularity: "hour" | "day";
    height?: number;
    ariaLabel: string;
    sectionError?: string;
  },
): void {
  const H = opts.height ?? 210;
  const W = Math.max(280, container.clientWidth || 560);
  const n = buckets.length;
  if (n === 0) {
    emptyNote(container, opts.sectionError);
    return;
  }

  const totals = buckets.map((_, i) => segments.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const maxVal = niceMax(Math.max(1, ...totals));
  // left margin sized to the widest y-tick label
  const TICKS = 4;
  const tickLabels = Array.from({ length: TICKS }, (_, k) => opts.yFmt((maxVal / TICKS) * (k + 1)));
  const m = {
    top: 10,
    right: 10,
    bottom: 22,
    left: Math.max(40, 12 + Math.max(...tickLabels.map((t) => t.length)) * 6.6),
  };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });

  const band = pw / n;
  const colW = Math.min(24, Math.max(3, band * 0.6));
  const yOf = (v: number) => m.top + ph - (v / maxVal) * ph;

  for (let t = 1; t <= TICKS; t++) {
    const v = (maxVal / TICKS) * t;
    const gy = yOf(v);
    const line = svgEl("line", { x1: m.left, x2: m.left + pw, y1: gy, y2: gy });
    line.setAttribute("class", "gridline");
    svg.appendChild(line);
    const label = svgEl("text", { x: m.left - 6, y: gy + 3, "text-anchor": "end" });
    label.textContent = tickLabels[t - 1];
    svg.appendChild(label);
  }
  const base = svgEl("line", { x1: m.left, x2: m.left + pw, y1: m.top + ph, y2: m.top + ph });
  base.setAttribute("class", "baseline");
  svg.appendChild(base);

  const tickStep = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += tickStep) {
    const label = svgEl("text", { x: m.left + band * i + band / 2, y: H - 6, "text-anchor": "middle" });
    label.textContent = bucketLabel(buckets[i].ts, opts.granularity);
    svg.appendChild(label);
  }

  const GAP = 2; // surface gap between stacked segments
  for (let i = 0; i < n; i++) {
    const g = svgEl("g");
    (g as SVGGElement).classList.add("col");
    const cx = m.left + band * i + (band - colW) / 2;
    let cursor = m.top + ph;
    const visible = segments.filter((s) => (s.values[i] ?? 0) > 0);
    visible.forEach((s, si) => {
      const v = s.values[i] ?? 0;
      let h = (v / maxVal) * ph;
      const isTop = si === visible.length - 1;
      const yTop = cursor - h;
      if (si > 0) h = Math.max(0.5, h - GAP);
      const shape = isTop
        ? svgEl("path", { d: roundedTopRect(cx, cursor - ((s.values[i] ?? 0) / maxVal) * ph + (si > 0 ? GAP : 0), colW, h, 4) })
        : svgEl("rect", { x: cx, y: yTop + (si > 0 ? GAP : 0), width: colW, height: h });
      shape.style.fill = `var(${s.cssVar})`;
      g.appendChild(shape);
      cursor = yTop;
    });
    const hit = svgEl("rect", {
      x: m.left + band * i,
      y: m.top,
      width: band,
      height: ph,
      fill: "transparent",
      tabindex: 0,
    });
    hit.setAttribute("class", "hit-col");
    const presentAt = (cxp: number, cyp: number) => {
      const rows: TooltipRow[] = segments.map((s) => ({
        name: s.name,
        value: opts.yFmt(s.values[i] ?? 0),
        cssVar: s.cssVar,
      }));
      rows.push({ name: "Total", value: opts.yFmt(totals[i]) });
      showTooltip(bucketLabel(buckets[i].ts, opts.granularity), rows, cxp, cyp);
    };
    hit.addEventListener("pointermove", (e) => presentAt(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", hideTooltip);
    hit.addEventListener("focus", () => {
      const r = svg.getBoundingClientRect();
      presentAt(r.left + cx, r.top + m.top + ph / 2);
    });
    hit.addEventListener("blur", hideTooltip);
    g.addEventListener("pointerenter", () => ((g as SVGGElement).style.filter = "brightness(1.08)"));
    g.addEventListener("pointerleave", () => ((g as SVGGElement).style.filter = ""));
    g.appendChild(hit);
    svg.appendChild(g);
  }
  container.appendChild(svg);
}

// ---------------------------------------------------------------- h-bars

interface HBarSeg {
  cssVar: string;
  value: number;
}

interface HBarRow {
  label: string;
  segs: HBarSeg[];
  display: string;
  tooltipTitle: string;
  tooltipRows: TooltipRow[];
}

function hBars(container: HTMLElement, rows: HBarRow[], sectionError?: string): void {
  if (rows.length === 0) {
    emptyNote(container, sectionError);
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.segs.reduce((a, s) => a + s.value, 0)));
  const wrap = el("div", "hbar-rows");
  for (const r of rows) {
    const row = el("div", "hbar-row");
    row.tabIndex = 0;
    row.appendChild(el("div", "hbar-label", r.label));
    const track = el("div", "hbar-track");
    const visible = r.segs.filter((s) => s.value > 0);
    visible.forEach((s, i) => {
      const seg = el("div", `hbar-seg ${i === visible.length - 1 ? "end" : "start"}`);
      seg.style.width = `${(s.value / max) * 100}%`;
      seg.style.background = `var(${s.cssVar})`;
      track.appendChild(seg);
    });
    row.appendChild(track);
    row.appendChild(el("div", "hbar-value", r.display));
    row.addEventListener("pointermove", (e) => showTooltip(r.tooltipTitle, r.tooltipRows, e.clientX, e.clientY));
    row.addEventListener("pointerleave", hideTooltip);
    row.addEventListener("focus", () => {
      const rect = row.getBoundingClientRect();
      showTooltip(r.tooltipTitle, r.tooltipRows, rect.left + rect.width / 2, rect.bottom);
    });
    row.addEventListener("blur", hideTooltip);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// ---------------------------------------------------------------- table/tile

interface Col<T> {
  label: string;
  get: (r: T) => string;
  cell?: (r: T) => HTMLElement; // custom cell content (e.g. drill-down button)
}

function emptyNote(container: HTMLElement, sectionError?: string): void {
  container.appendChild(
    sectionError
      ? el("div", "empty error", `Query failed: ${sectionError}`)
      : el("div", "empty", "No data in this window"),
  );
}

function table<T>(container: HTMLElement, cols: Col<T>[], rows: T[], sectionError?: string): void {
  if (rows.length === 0) {
    emptyNote(container, sectionError);
    return;
  }
  const scroll = el("div", "table-scroll");
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const c of cols) hr.appendChild(el("th", undefined, c.label));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const c of cols) {
      const td = el("td");
      if (c.cell) td.appendChild(c.cell(r));
      else td.textContent = c.get(r);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  scroll.appendChild(t);
  container.appendChild(scroll);
}

// 12-point stat-tile sparkline: de-emphasis stroke, current period as accent dot
function sparkline(values: Array<number | null>): SVGSVGElement | null {
  const nums = values.map((v) => v ?? 0);
  if (nums.length < 2) return null;
  const pts: number[] = [];
  const N = Math.min(12, nums.length);
  for (let i = 0; i < N; i++) {
    const lo = Math.floor((i / N) * nums.length);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) / N) * nums.length));
    pts.push(nums.slice(lo, hi).reduce((a, b) => a + b, 0) / (hi - lo));
  }
  const W = 76;
  const H = 26;
  const max = Math.max(1, ...pts);
  const x = (i: number) => 2 + (i / (N - 1)) * (W - 8);
  const y = (v: number) => H - 3 - (v / max) * (H - 7);
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  svg.classList.add("spark");
  const path = svgEl("path", {
    d: pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(""),
    fill: "none",
    "stroke-width": 1.5,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  path.style.stroke = "var(--spark-line)";
  svg.appendChild(path);
  const dot = svgEl("circle", { cx: x(N - 1), cy: y(pts[N - 1]), r: 2.5 });
  dot.style.fill = "var(--accent)";
  svg.appendChild(dot);
  return svg;
}

function tile(label: string, value: string, detail?: string, spark?: Array<number | null>): HTMLElement {
  const card = el("div", "card tile");
  card.appendChild(el("div", "label", label));
  card.appendChild(el("div", "value", value));
  if (detail) card.appendChild(el("div", "detail", detail));
  if (spark) {
    const s = sparkline(spark);
    if (s) card.appendChild(s);
  }
  return card;
}

function tileRow(...tiles: HTMLElement[]): HTMLElement {
  const row = el("div", "tile-row");
  tiles.forEach((t) => row.appendChild(t));
  return row;
}

interface LegendItem {
  name: string;
  cssVar: string;
  kind: "line" | "rect";
}

// Every chart card can expose its exact numbers as an accessible table.
interface ChartData {
  head: string[];
  rows: string[][];
}

function dataTable(dt: ChartData): HTMLElement {
  const details = el("details", "data-table");
  details.appendChild(el("summary", undefined, "Show data"));
  const scroll = el("div", "table-scroll");
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  dt.head.forEach((h) => hr.appendChild(el("th", undefined, h)));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el("tbody");
  dt.rows.forEach((r) => {
    const tr = el("tr");
    r.forEach((cell) => tr.appendChild(el("td", undefined, cell)));
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  scroll.appendChild(t);
  details.appendChild(scroll);
  return details;
}

function chartCard(
  title: string,
  sub: string | null,
  legend: LegendItem[],
  span: "full" | "half" = "full",
): { card: HTMLElement; body: HTMLElement } {
  const card = el("div", `card${span === "full" ? " span-full" : ""}`);
  card.appendChild(el("h2", undefined, title));
  if (sub) card.appendChild(el("div", "sub", sub));
  if (legend.length >= 2) {
    const lg = el("div", "legend");
    for (const item of legend) {
      const it = el("span", "item");
      const key = el("span", item.kind === "line" ? "key-line" : "key-rect");
      key.style.background = `var(${item.cssVar})`;
      it.appendChild(key);
      it.appendChild(document.createTextNode(item.name));
      lg.appendChild(it);
    }
    card.appendChild(lg);
  }
  const body = el("div");
  card.appendChild(body);
  return { card, body };
}

// ---------------------------------------------------------------- views

function renderOverview(d: DashboardData, main: HTMLElement): void {
  const o = d.overview;
  const ts = d.timeseries;
  main.appendChild(
    tileRow(
      tile("Events", fmtCompact(o.total_events), undefined, ts.map((b) => b.events)),
      tile("Sessions", fmtCompact(o.sessions)),
      tile("Users", fmtCompact(o.users)),
      tile("Error rate", fmtPct(o.error_rate_pct), `${fmtInt(o.errors)} errors`, ts.map((b) => b.errors)),
      tile("P95 latency", fmtMs(o.p95_latency_ms), "all events", ts.map((b) => b.p95_latency_ms)),
    ),
  );

  const events = chartCard("Events over time", null, [
    { name: "Events", cssVar: "--s1", kind: "line" },
    { name: "Errors", cssVar: "--s8", kind: "line" },
  ], "half");
  main.appendChild(events.card); // attach before measuring width
  lineChart(
    events.body,
    ts,
    [
      { name: "Events", cssVar: "--s1", values: ts.map((b) => b.events) },
      { name: "Errors", cssVar: "--s8", values: ts.map((b) => b.errors) },
    ],
    {
      yFmt: (v) => fmtInt(v),
      granularity: d.meta.granularity,
      ariaLabel: "Events and errors over time",
      areaFirst: true,
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (ts.length) {
    events.card.appendChild(
      dataTable({
        head: ["Bucket", "Events", "Errors"],
        rows: ts.map((b) => [bucketLabel(b.ts, d.meta.granularity), fmtInt(b.events), fmtInt(b.errors)]),
      }),
    );
  }

  const lat = chartCard("LLM latency over time", null, [
    { name: "p50", cssVar: "--s1", kind: "line" },
    { name: "p95", cssVar: "--s2", kind: "line" },
  ], "half");
  main.appendChild(lat.card);
  lineChart(
    lat.body,
    ts,
    [
      { name: "p50", cssVar: "--s1", values: ts.map((b) => b.p50_latency_ms) },
      { name: "p95", cssVar: "--s2", values: ts.map((b) => b.p95_latency_ms) },
    ],
    {
      yFmt: fmtMs,
      granularity: d.meta.granularity,
      ariaLabel: "LLM latency percentiles over time",
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (ts.length) {
    lat.card.appendChild(
      dataTable({
        head: ["Bucket", "p50", "p95"],
        rows: ts.map((b) => [bucketLabel(b.ts, d.meta.granularity), fmtMs(b.p50_latency_ms), fmtMs(b.p95_latency_ms)]),
      }),
    );
  }
}

function renderLatency(d: DashboardData, main: HTMLElement): void {
  const rows = d.latencyByAgent;
  const calls = rows.reduce((a, r) => a + r.calls, 0);
  const wavg = (get: (r: (typeof rows)[0]) => number | null): number | null => {
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const v = get(r);
      if (v != null) {
        num += v * r.calls;
        den += r.calls;
      }
    }
    return den ? num / den : null;
  };
  const slowest = rows[0];
  main.appendChild(
    tileRow(
      tile("LLM calls", fmtCompact(calls)),
      tile("Avg latency", fmtMs(wavg((r) => r.avg_total_ms))),
      tile("Avg TTFT", fmtMs(wavg((r) => r.avg_ttft_ms))),
      tile(
        "Slowest p95",
        fmtMs(slowest?.p95_total_ms),
        slowest ? `${slowest.agent} · ${slowest.model_id ?? "?"}` : undefined,
      ),
    ),
  );

  const bars = chartCard("p95 latency by agent and model", "LLM_RESPONSE events, sorted by p95", []);
  hBars(
    bars.body,
    rows.slice(0, 12).map((r) => ({
      label: `${r.agent} · ${r.model_id ?? "?"}`,
      segs: [{ cssVar: "--s1", value: r.p95_total_ms ?? 0 }],
      display: fmtMs(r.p95_total_ms),
      tooltipTitle: `${r.agent} · ${r.model_id ?? "?"}`,
      tooltipRows: [
        { name: "calls", value: fmtInt(r.calls) },
        { name: "p50", value: fmtMs(r.p50_total_ms), cssVar: "--s1" },
        { name: "p95", value: fmtMs(r.p95_total_ms), cssVar: "--s1" },
        { name: "p99", value: fmtMs(r.p99_total_ms), cssVar: "--s1" },
        { name: "avg TTFT", value: fmtMs(r.avg_ttft_ms) },
      ],
    })),
    d.meta.section_errors?.latency,
  );
  main.appendChild(bars.card);

  const tbl = chartCard("All agents", null, []);
  table(tbl.body, [
    { label: "Agent", get: (r) => `${r.agent} · ${r.model_id ?? "?"}` },
    { label: "Calls", get: (r) => fmtInt(r.calls) },
    { label: "Avg", get: (r) => fmtMs(r.avg_total_ms) },
    { label: "Avg TTFT", get: (r) => fmtMs(r.avg_ttft_ms) },
    { label: "p50", get: (r) => fmtMs(r.p50_total_ms) },
    { label: "p95", get: (r) => fmtMs(r.p95_total_ms) },
    { label: "p99", get: (r) => fmtMs(r.p99_total_ms) },
  ], rows, d.meta.section_errors?.latency);
  main.appendChild(tbl.card);
}

function renderTokens(d: DashboardData, main: HTMLElement): void {
  const prompt = d.timeseries.reduce((a, b) => a + b.prompt_tokens, 0);
  const completion = d.timeseries.reduce((a, b) => a + b.completion_tokens, 0);
  const llmCalls = d.timeseries.reduce((a, b) => a + b.llm_calls, 0);
  main.appendChild(
    tileRow(
      tile("Total tokens", fmtCompact(prompt + completion), undefined, d.timeseries.map((b) => b.prompt_tokens + b.completion_tokens)),
      tile("Prompt tokens", fmtCompact(prompt), undefined, d.timeseries.map((b) => b.prompt_tokens)),
      tile("Completion tokens", fmtCompact(completion), undefined, d.timeseries.map((b) => b.completion_tokens)),
      tile("Avg tokens / call", llmCalls ? fmtCompact((prompt + completion) / llmCalls) : "—", `${fmtCompact(llmCalls)} LLM calls`),
    ),
  );

  const cols = chartCard("Token usage over time", null, [
    { name: "Prompt", cssVar: "--s1", kind: "rect" },
    { name: "Completion", cssVar: "--s2", kind: "rect" },
  ]);
  main.appendChild(cols.card);
  stackedColumns(
    cols.body,
    d.timeseries,
    [
      { name: "Prompt", cssVar: "--s1", values: d.timeseries.map((b) => b.prompt_tokens) },
      { name: "Completion", cssVar: "--s2", values: d.timeseries.map((b) => b.completion_tokens) },
    ],
    {
      yFmt: (v) => fmtCompact(v),
      granularity: d.meta.granularity,
      ariaLabel: "Prompt and completion tokens over time",
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (d.timeseries.length) {
    cols.card.appendChild(
      dataTable({
        head: ["Bucket", "Prompt", "Completion"],
        rows: d.timeseries.map((b) => [
          bucketLabel(b.ts, d.meta.granularity),
          fmtInt(b.prompt_tokens),
          fmtInt(b.completion_tokens),
        ]),
      }),
    );
  }

  const models = chartCard("Model comparison", "LLM_RESPONSE and LLM_ERROR events", [], "half");
  table(models.body, [
    { label: "Model", get: (r) => r.model_id ?? "?" },
    { label: "Calls", get: (r) => fmtInt(r.calls) },
    { label: "Err %", get: (r) => fmtPct(r.error_rate_pct) },
    { label: "Avg prompt", get: (r) => fmtCompact(r.avg_prompt_tokens) },
    { label: "Avg compl.", get: (r) => fmtCompact(r.avg_completion_tokens) },
    { label: "Avg latency", get: (r) => fmtMs(r.avg_latency_ms) },
    { label: "p95", get: (r) => fmtMs(r.p95_latency_ms) },
    { label: "Avg TTFT", get: (r) => fmtMs(r.avg_ttft_ms) },
  ], d.modelComparison, d.meta.section_errors?.models);
  main.appendChild(models.card);

  const sessions = chartCard("Top sessions by tokens", "cost estimation: multiply by your per-model prices", [], "half");
  table(sessions.body, [
    { label: "Session", get: (r) => r.session_id.length > 24 ? `${r.session_id.slice(0, 24)}…` : r.session_id },
    { label: "Model", get: (r) => r.model_id ?? "?" },
    { label: "Calls", get: (r) => fmtInt(r.llm_calls) },
    { label: "Prompt", get: (r) => fmtCompact(r.total_prompt_tokens) },
    { label: "Completion", get: (r) => fmtCompact(r.total_completion_tokens) },
    { label: "Total", get: (r) => fmtCompact(r.total_tokens) },
    {
      label: "Trace",
      get: (r) => r.trace_ids?.[0] ?? "—",
      cell: (r) => {
        const tid = r.trace_ids?.[0];
        if (!tid) return el("span", undefined, "—");
        const b = el("button", "link-btn", "View");
        b.setAttribute("aria-label", `View trace for session ${r.session_id}`);
        b.addEventListener("click", () => void showTrace(tid));
        return b;
      },
    },
  ], d.topSessions, d.meta.section_errors?.sessions);
  main.appendChild(sessions.card);
}

function renderTools(d: DashboardData, main: HTMLElement): void {
  const rows = d.toolStats;
  const calls = rows.reduce((a, r) => a + r.total_calls, 0);
  const failures = rows.reduce((a, r) => a + r.failures, 0);
  const slowest = [...rows].sort((a, b) => (b.p95_latency_ms ?? 0) - (a.p95_latency_ms ?? 0))[0];
  main.appendChild(
    tileRow(
      tile("Tool calls", fmtCompact(calls)),
      tile("Failures", fmtCompact(failures), calls ? `${((failures / calls) * 100).toFixed(2)}% of calls` : undefined),
      tile("Slowest tool p95", fmtMs(slowest?.p95_latency_ms), slowest?.tool_name ?? undefined),
    ),
  );

  const bars = chartCard("Calls by tool", "TOOL_COMPLETED and TOOL_ERROR events", [
    { name: "Succeeded", cssVar: "--s1", kind: "rect" },
    { name: "Failed", cssVar: "--s8", kind: "rect" },
  ]);
  hBars(
    bars.body,
    rows.slice(0, 12).map((r) => ({
      label: `${r.tool_name ?? "?"}${r.tool_origin ? ` (${r.tool_origin})` : ""}`,
      segs: [
        { cssVar: "--s1", value: r.total_calls - r.failures },
        { cssVar: "--s8", value: r.failures },
      ],
      display: `${fmtCompact(r.total_calls)} · ${fmtPct(r.fail_rate_pct)} fail`,
      tooltipTitle: r.tool_name ?? "?",
      tooltipRows: [
        { name: "calls", value: fmtInt(r.total_calls) },
        { name: "succeeded", value: fmtInt(r.total_calls - r.failures), cssVar: "--s1" },
        { name: "failed", value: fmtInt(r.failures), cssVar: "--s8" },
        { name: "avg latency", value: fmtMs(r.avg_latency_ms) },
        { name: "p95 latency", value: fmtMs(r.p95_latency_ms) },
      ],
    })),
    d.meta.section_errors?.tools,
  );
  main.appendChild(bars.card);

  const tbl = chartCard("All tools", null, []);
  table(tbl.body, [
    { label: "Tool", get: (r) => r.tool_name ?? "?" },
    { label: "Origin", get: (r) => r.tool_origin ?? "—" },
    { label: "Calls", get: (r) => fmtInt(r.total_calls) },
    { label: "Failures", get: (r) => fmtInt(r.failures) },
    { label: "Fail %", get: (r) => fmtPct(r.fail_rate_pct) },
    { label: "Avg", get: (r) => fmtMs(r.avg_latency_ms) },
    { label: "p95", get: (r) => fmtMs(r.p95_latency_ms) },
  ], rows, d.meta.section_errors?.tools);
  main.appendChild(tbl.card);
}

// ---------------------------------------------------------------- app state

const VIEWS = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "latency", label: "Latency", render: renderLatency },
  { id: "tokens", label: "Tokens", render: renderTokens },
  { id: "tools", label: "Tools", render: renderTools },
] as const;

const mainEl = document.getElementById("view") as HTMLElement;
const tabsEl = document.getElementById("tabs") as HTMLElement;
const scopeEl = document.getElementById("scope-note") as HTMLElement;
const statusEl = document.getElementById("status-note") as HTMLElement;
const rangeEl = document.getElementById("f-range") as HTMLSelectElement;
const agentEl = document.getElementById("f-agent") as HTMLSelectElement;
const pulseWrapEl = document.getElementById("pulse-wrap") as HTMLElement;
const pulseEl = document.getElementById("pulse") as HTMLElement;
const footEl = document.getElementById("foot-note") as HTMLElement;

// Signature element: a slim, always-visible pulse of event volume that keeps
// fleet context on screen whichever tab is open.
function renderPulse(d: DashboardData): void {
  pulseEl.replaceChildren();
  const ts = d.timeseries;
  if (ts.length < 2) {
    pulseWrapEl.hidden = true;
    return;
  }
  pulseWrapEl.hidden = false;
  const W = Math.max(280, pulseEl.clientWidth || 800);
  const H = 46;
  const top = 14;
  const bottom = 4;
  const ph = H - top - bottom;
  const n = ts.length;
  const max = Math.max(1, ...ts.map((b) => b.events));
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => top + ph - (v / max) * ph;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Event volume over the selected window" });

  let d1 = "";
  ts.forEach((b, i) => {
    d1 += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.events).toFixed(1)}`;
  });
  const wash = svgEl("path", { d: `${d1}L${W},${H - bottom}L0,${H - bottom}Z` });
  wash.style.fill = "var(--wash)";
  svg.appendChild(wash);
  const line = svgEl("path", { d: d1, fill: "none", "stroke-width": 1.5, "stroke-linejoin": "round" });
  line.style.stroke = "var(--s1)";
  svg.appendChild(line);
  // mark only buckets whose error rate is clearly above the window's norm
  const totalEv = ts.reduce((a, b) => a + b.events, 0);
  const avgRate = totalEv ? ts.reduce((a, b) => a + b.errors, 0) / totalEv : 0;
  const threshold = Math.max(0.01, avgRate * 1.5);
  ts.forEach((b, i) => {
    if (b.events > 0 && b.errors / b.events > threshold) {
      const dot = svgEl("circle", { cx: x(i), cy: y(b.events), r: 2.4 });
      dot.style.fill = "var(--s8)";
      svg.appendChild(dot);
    }
  });

  const overlay = svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  overlay.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / W) * (n - 1))));
    showTooltip(
      bucketLabel(ts[i].ts, d.meta.granularity),
      [
        { name: "events", value: fmtInt(ts[i].events), cssVar: "--s1" },
        { name: "errors", value: fmtInt(ts[i].errors), cssVar: "--s8" },
      ],
      e.clientX,
      e.clientY,
    );
  });
  overlay.addEventListener("pointerleave", hideTooltip);
  svg.appendChild(overlay);
  pulseEl.appendChild(svg);
}

let data: DashboardData | null = null;
const initialView = VIEWS.find((v) => `#${v.id}` === location.hash)?.id;
let currentView: (typeof VIEWS)[number]["id"] = initialView ?? "overview";
const embedded = window.parent !== window;

function renderTabs(): void {
  tabsEl.replaceChildren();
  for (const v of VIEWS) {
    const b = el("button", undefined, v.label);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(v.id === currentView));
    b.addEventListener("click", () => {
      currentView = v.id;
      renderTabs();
      renderView();
    });
    tabsEl.appendChild(b);
  }
}

function renderView(): void {
  hideTooltip();
  mainEl.replaceChildren();
  if (!data) {
    mainEl.appendChild(el("div", "empty", "Waiting for data…"));
    return;
  }
  VIEWS.find((v) => v.id === currentView)!.render(data, mainEl);
}

function setData(d: DashboardData): void {
  data = d;
  const hours = Math.round((Date.parse(d.meta.end) - Date.parse(d.meta.start)) / 3_600_000);
  // reflect the data's actual window in the range control when it matches a preset
  if ([...rangeEl.options].some((o) => o.value === String(hours))) rangeEl.value = String(hours);
  scopeEl.replaceChildren();
  scopeEl.appendChild(el("span", "pill", d.meta.source === "mock" ? "sample data" : d.meta.source));
  scopeEl.appendChild(
    document.createTextNode(
      `last ${hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : `${hours} h`} · by ${d.meta.granularity}`,
    ),
  );
  const bytes = d.meta.bytes_processed;
  const fmtBytes =
    bytes == null
      ? null
      : bytes >= 1e9
        ? `${(bytes / 1e9).toFixed(2)} GB`
        : bytes >= 1e6
          ? `${(bytes / 1e6).toFixed(1)} MB`
          : `${Math.round(bytes / 1e3)} KB`;
  footEl.textContent =
    `BigQuery Agent Analytics · ${fmtCompact(d.overview.total_events)} events in window · updated ${new Date(
      d.meta.end,
    ).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` +
    (fmtBytes ? ` · ${fmtBytes} scanned${d.meta.cache_hit ? " (cached)" : ""}` : "");
  renderPulse(d);
  const selected = agentEl.value;
  agentEl.replaceChildren();
  const all = el("option", undefined, "All agents");
  all.value = "";
  agentEl.appendChild(all);
  for (const a of d.agentsList) {
    const o = el("option", undefined, a);
    o.value = a;
    agentEl.appendChild(o);
  }
  agentEl.value = d.agentsList.includes(selected) ? selected : (d.meta.agent ?? "");
  // one failed panel must not read as "no data" — say which panels failed
  const failed = Object.keys(d.meta.section_errors ?? {});
  if (failed.length) {
    statusEl.textContent = `${failed.length} panel${failed.length > 1 ? "s" : ""} failed to load: ${failed.join(", ")}`;
    statusEl.classList.add("error");
  } else {
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }
  renderView();
}

function extractData(result: any): DashboardData | null {
  const sc = result?.structuredContent;
  if (sc?.data?.overview) return sc.data as DashboardData;
  for (const c of result?.content ?? []) {
    if (c.type === "text") {
      try {
        const parsed = JSON.parse(c.text);
        if (parsed?.data?.overview) return parsed.data;
        if (parsed?.overview) return parsed;
      } catch {
        /* not JSON — skip */
      }
    }
  }
  return null;
}

let appBridge: App | null = null;

// Standalone (no MCP host): served over HTTP the page fetches live data from
// its own server, and a failed fetch is a real error — never silently
// replaced with sample data. Only the from-disk (file://) preview uses mocks.
async function fetchStandalone(
  hours: number | null,
  agent: string | undefined,
  signal: AbortSignal,
): Promise<DashboardData> {
  if (location.protocol.startsWith("http")) {
    // hours === null → let the server apply its configured default window
    const q = new URLSearchParams();
    if (hours != null) q.set("time_range_hours", String(hours));
    if (agent) q.set("agent", agent);
    const res = await fetch(`api/dashboard?${q}`, { signal, headers: authHeaders() });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}: response was not JSON`);
    }
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    if (!body?.data?.overview) throw new Error("malformed dashboard payload");
    return body.data as DashboardData;
  }
  const h = hours ?? Number(rangeEl.value);
  const end = new Date();
  const start = new Date(end.getTime() - h * 3_600_000);
  return mockDashboard(start, end, h <= 72 ? "hour" : "day", agent ?? null);
}

let rangeTouched = false;

// Only the most recent refresh may publish results: a slow older request must
// never overwrite newer filters (monotonic sequence + abort for HTTP).
let refreshSeq = 0;
let inflightAbort: AbortController | null = null;

async function refresh(): Promise<void> {
  const seq = ++refreshSeq;
  inflightAbort?.abort();
  const abort = new AbortController();
  inflightAbort = abort;

  const hours = Number(rangeEl.value);
  const agent = agentEl.value || undefined;
  mainEl.classList.add("loading");
  statusEl.textContent = "Refreshing…";
  statusEl.classList.remove("error");
  try {
    let d: DashboardData | null;
    if (embedded && appBridge) {
      const result = await appBridge.callServerTool({
        name: "query_agent_metrics",
        arguments: { time_range_hours: hours, ...(agent ? { agent } : {}) },
      });
      d = extractData(result);
      if (!d) throw new Error("no data in tool result");
    } else {
      d = await fetchStandalone(rangeTouched ? hours : null, agent, abort.signal);
    }
    if (seq !== refreshSeq) return; // superseded by a newer request
    setData(d);
  } catch (e) {
    if (seq !== refreshSeq || (e instanceof DOMException && e.name === "AbortError")) return;
    const detail = e instanceof Error ? e.message : String(e);
    statusEl.textContent = data
      ? `Refresh failed: ${detail} — showing previously loaded data`
      : `Load failed: ${detail}`;
    statusEl.classList.add("error");
  } finally {
    if (seq === refreshSeq) mainEl.classList.remove("loading");
  }
}

// ------------------------------------------------------------ trace drill-down

async function fetchTrace(traceId: string): Promise<TraceEvent[]> {
  const hours = Number(rangeEl.value);
  if (embedded && appBridge) {
    const result: any = await appBridge.callServerTool({
      name: "get_trace",
      arguments: { trace_id: traceId, time_range_hours: hours },
    });
    if (Array.isArray(result?.structuredContent?.data)) return result.structuredContent.data;
    throw new Error("no trace data in tool result");
  }
  if (location.protocol.startsWith("http")) {
    const q = new URLSearchParams({ trace_id: traceId, time_range_hours: String(hours) });
    const res = await fetch(`api/trace?${q}`, { headers: authHeaders() });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body?.data ?? [];
  }
  return mockTrace(traceId);
}

async function showTrace(traceId: string): Promise<void> {
  document.getElementById("trace-card")?.remove();
  const { card, body } = chartCard(`Trace ${traceId}`, "ordered agent_events for this trace", []);
  card.id = "trace-card";
  const h2 = card.querySelector("h2")!;
  const head = el("div", "trace-head");
  h2.replaceWith(head);
  head.appendChild(h2);
  const close = el("button", "trace-close", "Close");
  close.addEventListener("click", () => card.remove());
  head.appendChild(close);
  body.appendChild(el("div", "empty", "Loading trace…"));
  mainEl.appendChild(card);
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });

  try {
    const events = await fetchTrace(traceId);
    body.replaceChildren();
    if (!events.length) {
      body.appendChild(el("div", "empty", "No events found for this trace in the selected window"));
      return;
    }
    const t0 = Date.parse(events[0].timestamp);
    const list = el("div", "trace-timeline");
    for (const e of events) {
      const row = el("div", `trace-row${e.status === "ERROR" ? " error" : ""}`);
      row.appendChild(el("span", "trace-t", `+${((Date.parse(e.timestamp) - t0) / 1000).toFixed(1)}s`));
      row.appendChild(el("span", "trace-type", e.event_type));
      const detail =
        e.error_message ??
        (e.tool_name
          ? `${e.tool_name}${e.tool_origin ? ` (${e.tool_origin})` : ""}`
          : (e.llm_response ?? e.agent ?? ""));
      const detailEl = el("span", "trace-detail", detail ?? "");
      if (detail) detailEl.title = detail;
      row.appendChild(detailEl);
      row.appendChild(el("span", "trace-lat", e.latency_ms != null ? fmtMs(e.latency_ms) : ""));
      list.appendChild(row);
    }
    body.appendChild(list);
  } catch (err) {
    body.replaceChildren();
    body.appendChild(
      el("div", "empty error", `Trace load failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

rangeEl.addEventListener("change", () => {
  rangeTouched = true;
  void refresh();
});
agentEl.addEventListener("change", refresh);

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRerender(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderView();
    if (data) renderPulse(data);
  }, 150);
}
window.addEventListener("resize", scheduleRerender);
// MCP hosts can resize the iframe's content box without firing window.resize
let lastMainW = mainEl.clientWidth;
new ResizeObserver(() => {
  const w = mainEl.clientWidth;
  if (Math.abs(w - lastMainW) < 8) return;
  lastMainW = w;
  scheduleRerender();
}).observe(mainEl);

renderTabs();
renderView();

if (embedded) {
  const app = new App({ name: "BQAA Dashboard", version: "0.1.0" });
  app.ontoolresult = (result: any) => {
    const d = extractData(result);
    if (d) setData(d); // setData syncs the range control to the data's window
  };
  appBridge = app;
  app
    .connect()
    .catch((e: unknown) => {
      statusEl.textContent = `Host connection failed: ${e instanceof Error ? e.message : String(e)}`;
      statusEl.classList.add("error");
    });
} else {
  // Standalone preview (opened directly in a browser): sample data.
  void refresh();
}
