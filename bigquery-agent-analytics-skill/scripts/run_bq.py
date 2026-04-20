#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = [
#     "google-cloud-bigquery>=3.11",
# ]
# ///
"""Lightweight BigQuery executor for agent analytics queries.

Usage:
    python scripts/run_bq.py --start 2026-04-01 --end 2026-04-15 "SELECT ..."
    python scripts/run_bq.py --dry-run --start ... --end ... "SELECT ..."
    python scripts/run_bq.py --trace-id abc123 --start ... --end ... "SELECT ..."
    python scripts/run_bq.py --max-gb 5 "SELECT ..."

Features:
- Auto-injects {PROJECT}, {DATASET}, {TABLE} from environment variables
  so the LLM never needs to know the user's specific project/dataset/table.
- Binds BigQuery query parameters @start, @end, @trace_id from
  --start / --end / --trace-id flags. @start/@end accept ISO-8601
  timestamps or dates. Bare YYYY-MM-DD dates are UTC midnight for
  --start and end-of-day (23:59:59.999999Z) for --end so the named
  day is fully inclusive under BETWEEN @start AND @end.
- --dry-run mode estimates bytes scanned WITHOUT executing the query.
- --max-gb sets the billing safety limit (default 1 GB).

Invocation path: this script is designed to be invoked from the skill
root directory (e.g. `python scripts/run_bq.py ...`). If invoked from a
different working directory, pass the full path to the script; the
script does not read any files relative to the CWD.
"""
import sys
import json
import os
import argparse
from datetime import datetime, timedelta, timezone

from google.cloud import bigquery


def inject_placeholders(sql: str, project: str, dataset: str, table: str) -> str:
    """Replace {PROJECT}, {DATASET}, {TABLE} placeholders with env values."""
    return (
        sql.replace("{PROJECT}", project)
        .replace("{DATASET}", dataset)
        .replace("{TABLE}", table)
    )


def parse_ts(value: str, is_end: bool = False) -> datetime:
    """Parse an ISO-8601 timestamp or YYYY-MM-DD date as UTC.

    When ``is_end`` is True and ``value`` is a bare YYYY-MM-DD date, the
    returned timestamp is the last microsecond of that day (23:59:59.999999
    UTC) so ``--end 2026-04-15`` includes all events on April 15 under a
    ``BETWEEN @start AND @end`` filter. ISO-8601 inputs with explicit time
    components are unaffected.
    """
    try:
        if len(value) == 10 and value[4] == "-" and value[7] == "-":
            day = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            if is_end:
                return day + timedelta(days=1) - timedelta(microseconds=1)
            return day
        # fromisoformat handles "2026-04-15T12:00:00" and "...+00:00"
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"Invalid timestamp '{value}': {e}")


def parse_end_ts(value: str) -> datetime:
    """argparse adapter: parse ``--end`` with end-of-day semantics for bare dates."""
    return parse_ts(value, is_end=True)


def format_bytes(n: int) -> str:
    """Human-readable byte size."""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(n) < 1024:
            return f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} PB"


def build_query_parameters(args):
    """Build BigQuery ScalarQueryParameter list from CLI args."""
    params = []
    if args.start is not None:
        params.append(bigquery.ScalarQueryParameter("start", "TIMESTAMP", args.start))
    if args.end is not None:
        params.append(bigquery.ScalarQueryParameter("end", "TIMESTAMP", args.end))
    if args.trace_id is not None:
        params.append(bigquery.ScalarQueryParameter("trace_id", "STRING", args.trace_id))
    return params


def main():
    parser = argparse.ArgumentParser(description="Run a BigQuery query with safety limits")
    parser.add_argument("query", help="SQL query string")
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT_ID", ""), help="GCP project ID")
    parser.add_argument("--dataset", default=os.environ.get("BQ_DATASET", ""), help="BigQuery dataset")
    parser.add_argument("--table", default=os.environ.get("BQ_TABLE", "agent_events"), help="Table name (default: agent_events)")
    parser.add_argument("--start", type=parse_ts, default=None,
                        help="Bind @start parameter (ISO-8601 timestamp or YYYY-MM-DD date, UTC)")
    parser.add_argument("--end", type=parse_end_ts, default=None,
                        help="Bind @end parameter (ISO-8601 timestamp or YYYY-MM-DD date, UTC; "
                             "bare dates are treated as end-of-day 23:59:59.999999Z)")
    parser.add_argument("--trace-id", default=None, help="Bind @trace_id parameter (string)")
    parser.add_argument("--max-gb", type=int, default=1, help="Max bytes billed in GB (default: 1)")
    parser.add_argument("--dry-run", action="store_true", help="Estimate bytes scanned without executing")
    args = parser.parse_args()

    if not args.project:
        print("ERROR: Set GCP_PROJECT_ID env var or pass --project", file=sys.stderr)
        sys.exit(1)
    if not args.dataset:
        print("ERROR: Set BQ_DATASET env var or pass --dataset", file=sys.stderr)
        sys.exit(1)

    sql = inject_placeholders(args.query, args.project, args.dataset, args.table)
    query_parameters = build_query_parameters(args)

    client = bigquery.Client(project=args.project)

    if args.dry_run:
        job_config = bigquery.QueryJobConfig(
            dry_run=True,
            use_query_cache=False,
            use_legacy_sql=False,
            query_parameters=query_parameters,
        )
        try:
            job = client.query(sql, job_config=job_config)
            bytes_processed = job.total_bytes_processed
            print(json.dumps({
                "dry_run": True,
                "total_bytes_processed": bytes_processed,
                "human_readable": format_bytes(bytes_processed),
                "exceeds_limit": bytes_processed > args.max_gb * (1 << 30),
                "limit_gb": args.max_gb,
            }))
        except Exception as e:
            print(f"ERROR (dry-run): {e}", file=sys.stderr)
            sys.exit(1)
    else:
        job_config = bigquery.QueryJobConfig(
            maximum_bytes_billed=args.max_gb * (1 << 30),
            use_legacy_sql=False,
            query_parameters=query_parameters,
        )
        try:
            result = client.query(sql, job_config=job_config).result()
            for row in result:
                print(json.dumps(dict(row), default=str))
        except Exception as e:
            print(f"ERROR: {e}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    main()
