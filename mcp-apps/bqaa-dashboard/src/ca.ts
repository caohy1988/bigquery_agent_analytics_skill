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
  const timeout = AbortSignal.timeout(150_000);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  const token = await Promise.race([
    accessToken(),
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("Ask aborted while acquiring credentials")), { once: true });
    }),
  ]);

  // #5: pin the analysis to the filters the user is looking at
  const scopeInstruction = cfg.scope
    ? ` SCOPE: unless the user explicitly asks otherwise, restrict every query to timestamp BETWEEN '${cfg.scope.startIso}' AND '${cfg.scope.endIso}'` +
      (cfg.scope.agent ? ` AND agent = ${sqlStringLiteral(cfg.scope.agent)}` : "") +
      "."
    : "";

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
  return parseMessages(question, parsed);
}

export function parseMessages(question: string, parsed: any[]): AskResult {
  const answers: string[] = [];
  const steps: string[] = [];
  const followups: string[] = [];
  let sql: string | null = null;
  let schema: string[] = [];
  let rows: Array<Record<string, unknown>> = [];

  for (const m of parsed) {
    const sm = m?.systemMessage;
    if (!sm) continue;
    if (sm.text) {
      const parts: string[] = sm.text.parts ?? [];
      if (sm.text.textType === "FINAL_RESPONSE" || sm.text.textType == null) answers.push(parts.join(""));
      else if (sm.text.textType === "FOLLOWUP_QUESTIONS") followups.push(...parts);
      else if (sm.text.textType === "THOUGHT" && parts.length) steps.push(parts[0].slice(0, 120));
    }
    if (sm.data?.generatedSql) sql = sm.data.generatedSql;
    if (sm.data?.result) {
      schema = (sm.data.result.schema?.fields ?? []).map((f: any) => f.name);
      rows = (sm.data.result.data ?? []).slice(0, MAX_ROWS);
    }
  }
  return {
    question,
    answer: answers.join("\n\n").trim() || "The analysis completed without a final text answer.",
    steps,
    sql,
    schema,
    rows,
    followups: followups.filter(Boolean).slice(0, 3),
  };
}
