#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_openai_agents import BQAAOpenAIAgentsProcessor
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
    sql = f"""
    SELECT
      event_type,
      agent,
      session_id,
      JSON_VALUE(attributes, '$.writer.label') AS writer_label,
      JSON_VALUE(attributes, '$.writer.mode') AS writer_mode,
      JSON_VALUE(attributes, '$.session_metadata.source') AS source,
      JSON_VALUE(content, '$.tool') AS tool_name,
      JSON_VALUE(attributes, '$.model') AS model,
      status
    FROM `{config.project_id}.{config.dataset}.{config.table}`
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
    try:
        from agents.tracing import function_span
        from agents.tracing import generation_span
        from agents.tracing import set_trace_processors
        from agents.tracing import trace
    except ImportError as exc:
        raise SystemExit("Install optional dependency first: pip install openai-agents") from exc

    config = BQAAConfig(
        project_id=args.project,
        dataset=args.dataset,
        table=args.table,
        location=args.location,
        agent_name=args.agent,
        user_id=args.user,
        direct_write=True,
        writer_label=args.writer_label,
    )
    logger = BigQueryAgentAnalyticsLogger(config)
    processor = BQAAOpenAIAgentsProcessor(
        logger, agent_name=args.agent, user_id=args.user
    )
    # The smoke test replaces processors to avoid the default OpenAI exporter
    # needing an OPENAI_API_KEY. Production users should usually call
    # add_bqaa_trace_processor(), which uses add_trace_processor().
    set_trace_processors([processor])

    with trace(
        "BQAA OpenAI Agents SDK smoke",
        group_id=args.session_id,
        metadata={"source": "bqaa_openai_agents_smoke"},
    ):
        with generation_span(
            input="Plan a BQAA smoke test",
            output="Run tracing processor and verify rows",
            model=args.model,
        ):
            time.sleep(0.01)
        with function_span(
            name="lookup_bigquery_rows",
            input={"session_id": args.session_id},
            output={"rows": 4},
        ):
            time.sleep(0.01)
    processor.force_flush()

    rows = _query_inserted_rows(config, args.session_id)
    event_types = {str(row["event_type"]) for row in rows}
    expected = {"LLM_REQUEST", "LLM_RESPONSE", "TOOL_STARTING", "TOOL_COMPLETED"}
    missing = sorted(expected - event_types)
    result = {
        "project": config.project_id,
        "dataset": config.dataset,
        "table": config.table,
        "session_id": args.session_id,
        "row_count": len(rows),
        "event_types": sorted(event_types),
        "missing_event_types": missing,
        "rows": rows,
    }
    print(json.dumps(result, indent=2, default=str))
    return 1 if missing else 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Use OpenAI Agents SDK tracing primitives and export rows to BQAA."
    )
    parser.add_argument("--project", default=_default_project(), required=not _default_project())
    parser.add_argument("--dataset", default=_default_dataset())
    parser.add_argument("--table", default=os.environ.get("BQAA_TABLE") or "agent_events")
    parser.add_argument("--location", default=os.environ.get("BQAA_LOCATION") or "US")
    parser.add_argument("--agent", default=os.environ.get("BQAA_AGENT_NAME") or "openai-agents-smoke")
    parser.add_argument("--user", default=os.environ.get("BQAA_USER_ID") or os.environ.get("USER") or "local-user")
    parser.add_argument("--model", default=os.environ.get("BQAA_MODEL") or "gpt-test-agents")
    parser.add_argument("--session-id", default=f"openai-agents-smoke-{int(time.time())}")
    parser.add_argument(
        "--writer-label",
        default=os.environ.get("BQAA_WRITER_LABEL")
        or "bqaa-coding-agent-plugin/0.1.0/openai-agents-smoke",
    )
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(run(parse_args()))
