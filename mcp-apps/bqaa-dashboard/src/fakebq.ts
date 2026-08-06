// Controllable BigQuery fake — activated by BQAA_FAKE_BQ=<scenario> so the
// integration suite can execute the PRODUCTION query branches (runQuery,
// budgets, partial failures, caching, deadlines, job cancellation) without a
// real BigQuery backend. Never used unless the env var is set.
//
// Scenarios:
//   ok        — every query succeeds with plausible rows
//   fail_one  — the models-section query rejects; everything else succeeds
//   stall     — the overview query never resolves (exercises the deadline)

import { BQ_MIN_BYTES_PER_QUERY } from "./queries.js";

interface FakeJobOpts {
  query: string;
  params?: Record<string, unknown>;
  maximumBytesBilled?: string;
  dryRun?: boolean;
}

function rowsFor(query: string): any[] {
  if (query.includes("AS total_events")) {
    return [
      {
        total_events: 1000,
        errors: 25,
        error_rate_pct: 2.5,
        sessions: 40,
        agents: 2,
        users: 10,
        p95_latency_ms: 900,
        last_event_ts: "2026-08-06T00:00:00Z",
      },
    ];
  }
  if (query.includes("AS llm_calls") && query.includes("TIMESTAMP_TRUNC")) {
    return [
      { ts: "2026-08-05T00:00:00Z", events: 500, errors: 10, llm_calls: 150, prompt_tokens: 300000, completion_tokens: 50000, p50_latency_ms: 400, p95_latency_ms: 900 },
      { ts: "2026-08-06T00:00:00Z", events: 500, errors: 15, llm_calls: 160, prompt_tokens: 320000, completion_tokens: 52000, p50_latency_ms: 410, p95_latency_ms: 950 },
    ];
  }
  if (query.includes("llm_events")) {
    return [
      {
        model_id: "fake-model",
        calls: 310,
        error_rate_pct: 1.2,
        total_prompt_tokens: 620000,
        total_completion_tokens: 102000,
        avg_total_tokens: 2300,
        avg_prompt_tokens: 2000,
        avg_completion_tokens: 300,
        avg_latency_ms: 500,
        p50_latency_ms: 400,
        p95_latency_ms: 900,
        avg_ttft_ms: 120,
      },
    ];
  }
  if (query.includes("ARRAY_AGG(DISTINCT trace_id")) {
    return [
      {
        session_id: "fake-session",
        model_id: "fake-model",
        llm_calls: 12,
        total_prompt_tokens: 24000,
        total_completion_tokens: 4000,
        total_tokens: 28000,
        trace_ids: ["fakefakefakefake"],
      },
    ];
  }
  if (query.includes("SELECT DISTINCT agent")) return [{ agent: "fake-agent" }];
  if (query.includes("AS dim")) return [{ dim: "fake-agent", value: 42 }];
  return [];
}

export function makeFakeBigQuery(scenario: string): { createQueryJob: (opts: FakeJobOpts) => Promise<any[]> } {
  return {
    async createQueryJob(opts: FakeJobOpts) {
      if (opts.dryRun) {
        return [{ metadata: { statistics: { totalBytesProcessed: "1234567" } } }];
      }
      // real BigQuery rejects sub-minimum byte caps at job creation
      const maxBytes = Number(opts.maximumBytesBilled ?? 0);
      if (maxBytes < BQ_MIN_BYTES_PER_QUERY) {
        throw new Error(`maximumBytesBilled ${maxBytes} is below BigQuery's minimum of ${BQ_MIN_BYTES_PER_QUERY}`);
      }
      const failThis = scenario === "fail_one" && opts.query.includes("llm_events");
      const stallThis = scenario === "stall" && opts.query.includes("AS total_events");
      const job = {
        async getQueryResults() {
          if (failThis) throw new Error("synthetic models-section failure");
          if (stallThis) await new Promise(() => {}); // never resolves
          return [rowsFor(opts.query)];
        },
        async getMetadata() {
          return [{ statistics: { totalBytesProcessed: "1000000" } }];
        },
        async cancel() {
          console.log("FAKE_BQ_JOB_CANCELLED");
          return [{}];
        },
      };
      return [job];
    },
  };
}
