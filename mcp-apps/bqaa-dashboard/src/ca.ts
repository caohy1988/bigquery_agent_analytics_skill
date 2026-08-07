// BigQuery Conversational Analytics (Gemini Data Analytics API) bridge.
// Server-side only — the webapp's Ask tab and the ask_data MCP tool both go
// through askConversational(), so the conversation layer needs no MCP host.
//
// Requires: geminidataanalytics.googleapis.com enabled and the caller identity
// holding roles/geminidataanalytics.dataAgentStatelessUser plus BigQuery read.

import { GoogleAuth } from "google-auth-library";
import type { AskExchange, AskResult } from "./types.js";

const MAX_ROWS = 100;

// Exact BigQuery string literal for a user-supplied value: quotes, backslashes,
// and newlines are escaped rather than stripped, so an agent named with an
// apostrophe scopes to precisely that agent instead of a silently different one.
// #4: the requested scope is NON-OVERRIDABLE — the UI labels answers with
// this scope, so the analysis must never silently escape it. Questions that
// ask beyond the scope are answered within it, with the restriction stated.
export function buildScopeInstruction(scope?: { startIso: string; endIso: string; agent?: string }): string {
  if (!scope) return "";
  return (
    ` SCOPE (MANDATORY): every SQL query you run MUST include the predicate` +
    ` timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'` +
    (scope.agent ? ` AND agent = ${sqlStringLiteral(scope.agent)}` : "") +
    `. This applies even if the question asks for other ranges, agents, or the whole table —` +
    ` in that case answer within this scope and state that the analysis was restricted to it.`
  );
}

export function sqlStringLiteral(value: string): string {
  return `'${value
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}'`;
}

let auth: GoogleAuth | null = null;

async function accessToken(): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Could not obtain Google access token (check ADC / service account)");
  return token.token;
}

export interface CaConfig {
  project: string;
  dataset: string;
  table: string;
  location?: string; // default "global"
  // Per-QUERY byte cap on each CA-generated BigQuery query. CA may generate
  // and retry several queries per question, so this is NOT an aggregate
  // per-request budget — bound aggregate spend with project/user quotas.
  maxBilledBytes?: number;
  scope?: { startIso: string; endIso: string; agent?: string }; // active filters
}

const SYSTEM_INSTRUCTION =
  "The table contains BigQuery Agent Analytics telemetry (agent_events): one row per agent event. " +
  "event_type values include LLM_REQUEST/LLM_RESPONSE/LLM_ERROR, TOOL_STARTING/TOOL_COMPLETED/TOOL_ERROR, " +
  "HITL_* and lifecycle events. JSON columns: content ($.tool, $.response), attributes ($.model or $.model_version, " +
  "$.usage_metadata token counts), latency_ms ($.total_ms, $.time_to_first_token_ms). status is OK or ERROR. " +
  "The table is partitioned on timestamp — always constrain timestamp in queries. Answer concisely with numbers.";

export async function askConversational(
  cfg: CaConfig,
  question: string,
  history: AskExchange[] = [],
  callerSignal?: AbortSignal,
): Promise<AskResult> {
  const location = cfg.location ?? "global";
  const parent = `projects/${cfg.project}/locations/${location}`;
  const messages: unknown[] = [];
  for (const h of history.slice(-3)) {
    messages.push({ userMessage: { text: h.question.slice(0, 2000) } });
    messages.push({ systemMessage: { text: { parts: [h.answer.slice(0, 4000)] } } });
  }
  messages.push({ userMessage: { text: question.slice(0, 2000) } });

  // #20: one deadline covers the WHOLE request — including ADC token
  // acquisition, which would otherwise be able to hold Ask slots forever.
  // #8: an already-aborted signal must reject NOW, before credentials — a
  // listener alone would never fire for a pre-aborted signal.
  if (callerSignal?.aborted) throw new Error("Ask aborted before start");
  const timeout = AbortSignal.timeout(150_000);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  if (signal.aborted) throw new Error("Ask aborted before start");
  const token = await Promise.race([
    accessToken(),
    new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error("Ask aborted while acquiring credentials"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }),
  ]);

  const scopeInstruction = buildScopeInstruction(cfg.scope);

  const res = await fetch(`https://geminidataanalytics.googleapis.com/v1beta/${parent}:chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent,
      messages,
      inlineContext: {
        systemInstruction: SYSTEM_INSTRUCTION + scopeInstruction,
        // The Ask path must honor the same cost boundary as the dashboard:
        // cap the bytes CA-generated queries may bill.
        ...(cfg.maxBilledBytes
          ? { options: { datasource: { bigQueryMaxBilledBytes: String(cfg.maxBilledBytes) } } }
          : {}),
        datasourceReferences: {
          bq: {
            tableReferences: [{ projectId: cfg.project, datasetId: cfg.dataset, tableId: cfg.table }],
          },
        },
      },
    }),
    signal,
  });

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 400);
    try {
      detail = JSON.parse(raw)?.error?.message ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Conversational Analytics API ${res.status}: ${detail}`);
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Conversational Analytics returned a non-JSON stream");
  }
  return withScope(parseMessages(question, parsed), cfg.scope);
}

export function parseMessages(question: string, parsed: any[]): AskResult {
  const answers: string[] = [];
  const steps: string[] = [];
  const followups: string[] = [];
  // #1(r8): SQL/result provenance is preserved as PAIRS. CA runs several
  // queries per question; displayed rows must come from the same query as the
  // displayed SQL, and scope verification must cover every data-bearing pair.
  interface QueryPair {
    sql: string | null;
    schema: string[];
    rows: Array<Record<string, unknown>>;
    hasResult: boolean;
  }
  const pairs: QueryPair[] = [];
  let current: QueryPair | null = null;

  for (const m of parsed) {
    const sm = m?.systemMessage;
    if (!sm) continue;
    if (sm.text) {
      const parts: string[] = sm.text.parts ?? [];
      if (sm.text.textType === "FINAL_RESPONSE" || sm.text.textType == null) answers.push(parts.join(""));
      else if (sm.text.textType === "FOLLOWUP_QUESTIONS") followups.push(...parts);
      else if (sm.text.textType === "THOUGHT" && parts.length) steps.push(parts[0].slice(0, 120));
    }
    if (sm.data?.generatedSql) {
      current = { sql: sm.data.generatedSql, schema: [], rows: [], hasResult: false };
      pairs.push(current);
    }
    if (sm.data?.result) {
      if (!current || current.hasResult) {
        // a result with no owning SQL is an ambiguous stream — keep it as a
        // pair with sql:null so verification fails closed
        current = { sql: null, schema: [], rows: [], hasResult: false };
        pairs.push(current);
      }
      current.schema = (sm.data.result.schema?.fields ?? []).map((f: any) => f.name);
      current.rows = (sm.data.result.data ?? []).slice(0, MAX_ROWS);
      current.hasResult = true;
    }
  }

  const dataPairs = pairs.filter((p) => p.hasResult);
  const display = dataPairs.length ? dataPairs[dataPairs.length - 1] : null;
  const lastSql = [...pairs].reverse().find((p) => p.sql)?.sql ?? null;
  return {
    question,
    answer: answers.join("\n\n").trim() || "The analysis completed without a final text answer.",
    steps,
    // the displayed SQL is the one that PRODUCED the displayed rows
    sql: display ? display.sql : lastSql,
    schema: display?.schema ?? [],
    rows: display?.rows ?? [],
    followups: followups.filter(Boolean).slice(0, 3),
    queries: pairs.map((p) => ({ sql: p.sql, row_count: p.hasResult ? p.rows.length : 0, data_bearing: p.hasResult })),
  };
}

// #3(r7): the scope instruction is prompt-level, so the label must be earned:
// the generated SQL is checked for the scope's predicates, and the result
// reports verified: true only when every check passes. Unverifiable or
// missing-predicate SQL is reported truthfully as NOT verified.
// #2(r8): substring checks verified comments, projected literals, and
// prefix-matched agents. This validation is structural and FAIL-CLOSED:
// comments are stripped, the time bound must be an actual
// `timestamp BETWEEN '<start>' AND '<end>'` predicate with exactly the
// scope's literals, and every `agent = '<value>'` predicate must equal the
// scope's agent exactly — any other agent predicate, or none, fails.
export function verifyScope(
  sql: string | null,
  scope?: { startIso: string; endIso: string; agent?: string },
): boolean {
  if (!scope) return true;
  if (!sql) return false; // nothing to verify against
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
  const timeRe =
    /\btimestamp\b\s+BETWEEN\s+(?:TIMESTAMP\s*\(\s*)?'([^']+)'\s*\)?\s+AND\s+(?:TIMESTAMP\s*\(\s*)?'([^']+)'\s*\)?/i;
  const tm = timeRe.exec(stripped);
  if (!tm || tm[1] !== scope.startIso || tm[2] !== scope.endIso) return false;
  if (scope.agent) {
    const agentRe = /\bagent\b\s*=\s*'((?:[^'\\]|\\.)*)'/gi;
    let matchedScope = false;
    let m: RegExpExecArray | null;
    while ((m = agentRe.exec(stripped))) {
      const value = m[1].replaceAll("\\'", "'").replaceAll("\\\\", "\\");
      if (value === scope.agent) matchedScope = true;
      else return false; // a predicate on a DIFFERENT agent can never verify
    }
    if (!matchedScope) return false;
  }
  return true;
}

export function withScope(result: AskResult, scope?: { startIso: string; endIso: string; agent?: string }): AskResult {
  if (!scope) return result;
  // #1(r8): EVERY data-bearing query must pass — one unscoped result row set
  // poisons the whole answer. Streams with results but no owning SQL fail
  // closed; a purely textual answer verifies against the final SQL if any.
  const dataPairs = (result.queries ?? []).filter((q) => q.data_bearing);
  const verified = dataPairs.length
    ? dataPairs.every((q) => q.sql != null && verifyScope(q.sql, scope))
    : verifyScope(result.sql, scope);
  return {
    ...result,
    scope: { ...scope, verified },
    answer: verified
      ? result.answer
      : `${result.answer}\n\n⚠ Scope not verified: the generated SQL could not be confirmed to contain the selected time window${scope.agent ? " and agent filter" : ""}. Treat this answer as potentially covering a different slice.`,
  };
}
