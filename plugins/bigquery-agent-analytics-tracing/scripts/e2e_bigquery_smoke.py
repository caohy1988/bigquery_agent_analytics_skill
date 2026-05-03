#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_tracing import BQAAConfig
from bqaa_tracing import BigQueryAgentAnalyticsLogger


def _default_project() -> str:
    return (
        os.environ.get("BQAA_PROJECT_ID")
        or os.environ.get("GCP_PROJECT_ID")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or ""
    )


def _default_dataset() -> str:
    return os.environ.get("BQAA_DATASET") or os.environ.get("BQ_DATASET") or "agent_analytics"


def _query_inserted_rows(config: BQAAConfig, session_id: str) -> list[dict[str, object]]:
    from google.cloud import bigquery

    client = bigquery.Client(project=config.project_id, location=config.location)
    table = f"`{config.project_id}.{config.dataset}.{config.table}`"
    sql = f"""
    SELECT
      event_type,
      agent,
      session_id,
      invocation_id,
      trace_id,
      span_id,
      parent_span_id,
      JSON_VALUE(content, '$.tool') AS tool_name,
      JSON_VALUE(content, '$.response') AS response_text,
      CAST(JSON_VALUE(latency_ms, '$.total_ms') AS INT64) AS total_ms,
      status
    FROM {table}
    WHERE session_id = @session_id
      AND timestamp BETWEEN @start AND @end
    ORDER BY timestamp ASC, event_type ASC
    """
    now = datetime.now(timezone.utc)
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("session_id", "STRING", session_id),
            bigquery.ScalarQueryParameter("start", "TIMESTAMP", now - timedelta(hours=1)),
            bigquery.ScalarQueryParameter("end", "TIMESTAMP", now + timedelta(hours=1)),
        ]
    )
    return [dict(row) for row in client.query(sql, job_config=job_config).result()]


def run(args: argparse.Namespace) -> int:
    session_id = args.session_id or f"bqaa-smoke-{uuid.uuid4().hex}"
    invocation_id = f"inv-{uuid.uuid4().hex}"
    trace_id = uuid.uuid4().hex
    llm_span_id = uuid.uuid4().hex[:16]
    tool_span_id = uuid.uuid4().hex[:16]
    tool_start = time.time()

    config = BQAAConfig(
        project_id=args.project,
        dataset=args.dataset,
        table=args.table,
        agent_name=args.agent,
        user_id=args.user,
        dry_run=args.dry_run,
        auto_create_table=not args.no_create_table,
        auto_create_dataset=args.create_dataset,
        location=args.location,
        max_content_length=args.max_content_length,
        log_file=args.log_file,
    )
    logger = BigQueryAgentAnalyticsLogger(config)

    logger.log_llm_request(
        prompt="BQAA tracing smoke test: inspect repository and summarize status.",
        session_id=session_id,
        invocation_id=invocation_id,
        trace_id=trace_id,
        span_id=llm_span_id,
        agent=args.agent,
        user_id=args.user,
        attributes={
            "session_metadata": {
                "source": "bqaa_e2e_smoke",
                "repository": "bigquery_agent_analytics_skill",
            },
            "custom_tags": {
                "smoke_test": True,
                "assistant": "codex",
            },
        },
    )
    logger.log_tool_starting(
        tool="Read",
        args={"file_path": "README.md"},
        session_id=session_id,
        invocation_id=invocation_id,
        trace_id=trace_id,
        span_id=tool_span_id,
        parent_span_id=llm_span_id,
        agent=args.agent,
        tool_origin="LOCAL",
    )
    logger.log_tool_completed(
        tool="Read",
        result={"ok": True, "summary": "README loaded for smoke test"},
        session_id=session_id,
        invocation_id=invocation_id,
        trace_id=trace_id,
        span_id=tool_span_id,
        parent_span_id=llm_span_id,
        agent=args.agent,
        tool_origin="LOCAL",
        total_ms=int((time.time() - tool_start) * 1000),
    )
    logger.log_llm_response(
        response="Smoke trace inserted into BigQuery Agent Analytics.",
        session_id=session_id,
        invocation_id=invocation_id,
        trace_id=trace_id,
        span_id=llm_span_id,
        agent=args.agent,
        user_id=args.user,
        model=args.model,
        usage_metadata={
            "prompt_tokens": 12,
            "completion_tokens": 8,
            "total_tokens": 20,
        },
        total_ms=1234,
        attributes={
            "session_metadata": {
                "source": "bqaa_e2e_smoke",
                "repository": "bigquery_agent_analytics_skill",
            },
            "custom_tags": {
                "smoke_test": True,
                "assistant": "codex",
            },
        },
    )

    if args.dry_run:
        print(json.dumps({"dry_run": True, "session_id": session_id}, indent=2))
        return 0

    rows = _query_inserted_rows(config, session_id)
    event_types = {str(row["event_type"]) for row in rows}
    expected = {"LLM_REQUEST", "TOOL_STARTING", "TOOL_COMPLETED", "LLM_RESPONSE"}
    missing = sorted(expected - event_types)
    result = {
        "project": config.project_id,
        "dataset": config.dataset,
        "table": config.table,
        "session_id": session_id,
        "trace_id": trace_id,
        "row_count": len(rows),
        "event_types": sorted(event_types),
        "missing_event_types": missing,
        "rows": rows,
    }
    print(json.dumps(result, indent=2, default=str))
    return 1 if missing else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Insert a complete BQAA trace into BigQuery and query it back."
    )
    parser.add_argument("--project", default=_default_project(), required=not _default_project())
    parser.add_argument("--dataset", default=_default_dataset())
    parser.add_argument("--table", default=os.environ.get("BQAA_TABLE") or "agent_events")
    parser.add_argument("--location", default=os.environ.get("BQAA_LOCATION") or None)
    parser.add_argument("--agent", default=os.environ.get("BQAA_AGENT_NAME") or "codex-smoke")
    parser.add_argument("--user", default=os.environ.get("BQAA_USER_ID") or os.environ.get("USER") or "local-user")
    parser.add_argument("--model", default=os.environ.get("BQAA_MODEL") or "codex-smoke-model")
    parser.add_argument("--session-id", default="")
    parser.add_argument("--log-file", default=os.environ.get("BQAA_LOG_FILE") or "/tmp/bqaa-agent-tracing.log")
    parser.add_argument("--max-content-length", type=int, default=int(os.environ.get("BQAA_MAX_CONTENT_LENGTH", "5000")))
    parser.add_argument("--create-dataset", action="store_true")
    parser.add_argument("--no-create-table", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
