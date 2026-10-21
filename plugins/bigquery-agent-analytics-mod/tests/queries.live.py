#!/usr/bin/env python3
"""Live: runs every query in sql/value_queries.sql and sql/sample_queries.sql
through the analysis skill's runner (bigquery-agent-analytics-skill/scripts/
run_bq.py) against a synthetic fixture, and checks the answers.

The fixture holds what the queries must count right:
  - a row the mod sent twice (a replay: the same event_id);
  - a session with no user_id;
  - other producers in the same table: the settings-hook tracer's rows and
    an ADK agent's, the latter with no event_id and its tokens under
    usage_metadata.total_token_count;
  - a subagent run;
  - both answers to a permission prompt, and a hook's denial.

It makes a dataset of its own (bqaa_query_check_<random>, in US), with the
events table and a team_roster table, prints each query's dry-run bytes,
and deletes the dataset when it is done. It needs the Python BigQuery
client and Application Default Credentials that may create a dataset:

  PROJECT=my-gcp-project python3 tests/queries.live.py
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MOD = HERE.parent
RUNNER = MOD.parents[1] / "bigquery-agent-analytics-skill" / "scripts" / "run_bq.py"
START, END = "2026-10-19", "2026-10-20"

MOD_WRITER = {"plugin": "bigquery-agent-analytics-mod", "version": "0.1.0", "label": "bigquery-agent-analytics-mod/0.1.0"}
TRACER_WRITER = {"plugin": "bqaa-coding-agent-plugin", "version": "0.1.0", "label": "bqaa-coding-agent-plugin/0.1.0"}


def usage(input_tokens, output_tokens, cache_read=0, cache_write=0):
    return {"input_tokens": input_tokens, "output_tokens": output_tokens,
            "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": cache_write,
            "prompt_tokens": input_tokens + cache_read + cache_write,
            "total_tokens": input_tokens + output_tokens + cache_read + cache_write}


def row(event_id, ts, event_type, session, *, user="alice", invocation=None, agent="coding-agent", trace=None,
        span=None, parent=None, content=None, attributes=None, latency=None, status="OK", writer=MOD_WRITER):
    attrs = dict(attributes or {})
    if writer is not None:
        attrs["writer"] = writer
    return {"event_id": event_id, "timestamp": ts, "event_type": event_type, "agent": agent, "session_id": session,
            "invocation_id": invocation, "user_id": user, "trace_id": trace, "span_id": span or event_id,
            "parent_span_id": parent, "content": content or {}, "attributes": attrs, "latency_ms": latency,
            "status": status, "is_truncated": False}


D1, D2 = "2026-10-19T10:00:", "2026-10-20T11:00:"
I1 = dict(invocation="I1", trace="trace-1")
FIXTURE = [
    # S1: alice, day 1, one turn with two model requests, a tool that asked
    # for permission and was allowed, and a tool that failed.
    row("e01", D1 + "00Z", "STATE_DELTA", "S1", content={"session_start": True}),
    row("e02", D1 + "01Z", "USER_MESSAGE_RECEIVED", "S1", **I1, content={"text_summary": "list the files"}),
    row("e03", D1 + "01Z", "INVOCATION_STARTING", "S1", **I1, span="inv-1"),
    row("e04", D1 + "02Z", "LLM_REQUEST", "S1", **I1, span="req-1", parent="inv-1", attributes={"model": "model-a"}),
    row("e05", D1 + "03Z", "LLM_RESPONSE", "S1", **I1, span="req-1", parent="inv-1",
        attributes={"model": "model-a", "usage_metadata": usage(100, 20, 50, 10)},
        latency={"total_ms": 1000, "time_to_first_token_ms": 300}),
    row("e06", D1 + "04Z", "TOOL_STARTING", "S1", **I1, span="tool-1", parent="req-1", content={"tool": "Bash"}),
    row("e07", D1 + "05Z", "TOOL_COMPLETED", "S1", **I1, span="tool-1", parent="req-1",
        content={"tool": "Bash", "tool_origin": "builtin"},
        attributes={"permission_requested": True, "permission_decision": "accept"}, latency={"total_ms": 500}),
    row("e08", D1 + "06Z", "TOOL_COMPLETED", "S1", **I1, span="tool-2", parent="req-1",
        content={"tool": "Edit", "tool_origin": "builtin"}, latency={"total_ms": 200}, status="ERROR"),
    row("e09", D1 + "07Z", "LLM_RESPONSE", "S1", **I1, span="req-2", parent="inv-1",
        attributes={"model": "model-a", "usage_metadata": usage(10, 5)},
        latency={"total_ms": 400, "time_to_first_token_ms": 100}),
    row("e10", D1 + "08Z", "AGENT_RESPONSE", "S1", **I1, parent="inv-1"),
    row("e11", D1 + "08Z", "INVOCATION_COMPLETED", "S1", **I1, span="inv-1",
        attributes={"usage_metadata": {"total_tokens": 195}, "finish_reason": "end_turn"}, latency={"total_ms": 7000}),
    # S2: bob, day 2: a rejected prompt, a hook's denial, a subagent run, a
    # failed model request and a failed turn.
    row("e12", D2 + "00Z", "USER_MESSAGE_RECEIVED", "S2", user="bob", invocation="I2"),
    row("e13", D2 + "00Z", "INVOCATION_STARTING", "S2", user="bob", invocation="I2"),
    row("e14", D2 + "01Z", "LLM_RESPONSE", "S2", user="bob", invocation="I2",
        attributes={"model": "model-b", "usage_metadata": usage(200, 40)},
        latency={"total_ms": 1500, "time_to_first_token_ms": 500}),
    row("e15", D2 + "02Z", "TOOL_COMPLETED", "S2", user="bob", invocation="I2", content={"tool": "Bash", "tool_origin": "builtin"},
        attributes={"permission_requested": True, "permission_decision": "reject"}, latency={"total_ms": 300},
        status="ERROR"),
    row("e16", D2 + "03Z", "TOOL_COMPLETED", "S2", user="bob", invocation="I2", content={"tool": "WebFetch", "tool_origin": "builtin"},
        attributes={"denied": True}, latency={"total_ms": 0}, status="ERROR"),
    row("e17", D2 + "04Z", "AGENT_STARTING", "S2", user="bob", invocation="I2", agent="general-purpose"),
    row("e18", D2 + "05Z", "LLM_RESPONSE", "S2", user="bob", invocation="I2", agent="general-purpose",
        attributes={"model": "model-a", "usage_metadata": usage(30, 20)},
        latency={"total_ms": 800, "time_to_first_token_ms": 200}),
    row("e19", D2 + "06Z", "AGENT_COMPLETED", "S2", user="bob", invocation="I2", agent="general-purpose",
        attributes={"usage_metadata": {"total_tokens": 50}}, latency={"total_ms": 2000}),
    row("e20", D2 + "07Z", "LLM_ERROR", "S2", user="bob", invocation="I2", attributes={"model": "model-a"},
        status="ERROR"),
    row("e21", D2 + "08Z", "INVOCATION_ERROR", "S2", user="bob", invocation="I2", latency={"total_ms": 8000},
        status="ERROR"),
    # S3: no user_id.
    row("e22", "2026-10-20T12:00:00Z", "LLM_RESPONSE", "S3", user=None, invocation="I3",
        attributes={"model": "model-a", "usage_metadata": usage(20, 10)}, latency={"total_ms": 600}),
    # The settings-hook tracer, writing beside the mod.
    row("t01", "2026-10-20T13:00:00Z", "LLM_RESPONSE", "T1", writer=TRACER_WRITER,
        attributes={"model": "model-a", "usage_metadata": {"input_tokens": 900, "output_tokens": 99, "total_tokens": 999}}),
    row("t02", "2026-10-20T13:00:01Z", "TOOL_COMPLETED", "T1", writer=TRACER_WRITER, content={"tool": "Bash"},
        status="ERROR"),
    # An ADK agent: no writer, no event_id, tokens as total_token_count.
    row(None, "2026-10-20T14:00:00Z", "LLM_RESPONSE", "A1", user="carol", agent="adk-agent", writer=None,
        attributes={"model": "model-c", "usage_metadata": {"total_token_count": 77}}),
    row(None, "2026-10-20T14:00:01Z", "TOOL_COMPLETED", "A1", user="carol", agent="adk-agent", writer=None,
        content={"tool": "search"}, status="ERROR"),
]
# The replay: e05 sent twice.
FIXTURE.append(dict(FIXTURE[4]))
ROSTER = ["alice", "bob", "dave"]
RATES = """SELECT * FROM UNNEST([
    STRUCT('model-a' AS model, DATE '2026-10-01' AS rates_as_of, 'fixture' AS rates_source,
           2.0 AS input_usd, 0.5 AS cache_read_usd, 4.0 AS cache_write_usd, 10.0 AS output_usd)
  ])"""


def by(rows, *keys):
    return {tuple(r[k] for k in keys) if len(keys) > 1 else r[keys[0]]: r for r in rows}


def near(a, b):
    return a is not None and abs(float(a) - b) < 1e-9


def checks(name: str, rows: list[dict]):
    """(description, passed) for a query's answer on the fixture."""
    if name == "V1":
        s = by(rows, "session_id")
        yield "the mod's sessions, and no other producer's", set(s) == {"S1", "S2", "S3"}
        yield "S1: 2 model requests and 195 tokens (the replayed row counted once)", s["S1"]["model_requests"] == 2 and s["S1"]["tokens"] == 195
        yield "S1: 2 tool calls, 1 failed; 1 prompt, 1 turn", (s["S1"]["tool_calls"], s["S1"]["failed_tool_calls"], s["S1"]["prompts"], s["S1"]["turns"]) == (2, 1, 1, 1)
        yield "S2: 290 tokens with the subagent's, 2 failed tool calls", s["S2"]["tokens"] == 290 and s["S2"]["failed_tool_calls"] == 2
        yield "S3: kept with no user_id", "S3" in s and s["S3"]["user_id"] is None and s["S3"]["tokens"] == 30
    elif name == "V2":
        t = by(rows, "invocation_id")
        yield "I1: turn 7000 ms, models 1400 ms, tools 700 ms, 1 permission prompt", (t["I1"]["turn_ms"], t["I1"]["model_ms"], t["I1"]["tool_ms"], t["I1"]["permission_prompts"]) == (7000, 1400, 700, 1)
        yield "I2: turn 8000 ms, models 2300 ms (with the subagent's), tools 300 ms", (t["I2"]["turn_ms"], t["I2"]["model_ms"], t["I2"]["tool_ms"]) == (8000, 2300, 300)
        yield "I3: no end of turn recorded: turn_ms is NULL, not 0", t["I3"]["turn_ms"] is None and t["I3"]["model_ms"] == 600
    elif name == "V3":
        d = by(rows, "day")
        yield "day 1: 3 enrolled, 1 seen, 2 not seen, 1 session, 1 turn", (d["2026-10-19"]["enrolled"], d["2026-10-19"]["enrolled_seen"], d["2026-10-19"]["enrolled_not_seen"], d["2026-10-19"]["enrolled_sessions"], d["2026-10-19"]["enrolled_turns"]) == (3, 1, 2, 1, 1)
        yield "day 2: 1 enrolled seen (bob); the session with no user_id is apart", (d["2026-10-20"]["enrolled_seen"], d["2026-10-20"]["enrolled_sessions"], d["2026-10-20"]["other_sessions"]) == (1, 1, 1)
        yield "the tracer's and ADK's people are not counted", all(r["enrolled_sessions"] + r["other_sessions"] <= 2 for r in rows)
    elif name == "V4":
        c = by(rows, "session_id", "model")
        yield "S1 model-a: 2 requests; 110 input, 50 cache reads, 10 cache writes, 25 output", (c[("S1", "model-a")]["model_requests"], c[("S1", "model-a")]["input_tokens"], c[("S1", "model-a")]["cache_read_tokens"], c[("S1", "model-a")]["cache_write_tokens"], c[("S1", "model-a")]["output_tokens"]) == (2, 110, 50, 10, 25)
        yield "S1 model-a: estimated 0.000535 USD at the fixture's rates, dated", near(c[("S1", "model-a")]["estimated_usd"], 0.000535) and c[("S1", "model-a")]["rates_as_of"] == "2026-10-01"
        yield "S2 model-b: no rate row, so no cost (NULL, not 0)", c[("S2", "model-b")]["estimated_usd"] is None
        yield "S2 model-a (the subagent's request): 0.00026 USD", near(c[("S2", "model-a")]["estimated_usd"], 0.00026)
        yield "the tracer's model-a response is not counted", ("T1", "model-a") not in c
    elif name == "V5":
        t = by(rows, "tool")
        yield "tools: Bash, Edit, WebFetch (not the tracer's or ADK's)", set(t) == {"Bash", "Edit", "WebFetch"}
        yield "Bash: 2 people, 2 calls, 50% failed, 100% asked, 50% rejected at the prompt", (t["Bash"]["people"], t["Bash"]["calls"], t["Bash"]["error_pct"], t["Bash"]["asked_pct"], t["Bash"]["rejected_pct"], t["Bash"]["denied_by_hook_pct"]) == (2, 2, 50.0, 100.0, 50.0, 0.0)
        yield "WebFetch: denied by a hook, 100%", t["WebFetch"]["denied_by_hook_pct"] == 100.0 and t["WebFetch"]["rejected_pct"] == 0.0
    elif name == "V6":
        d = by(rows, "day")
        yield "day 1: 1 turn, 0 failed; 2 model requests; 2 tool calls, 1 failed", (d["2026-10-19"]["turns"], d["2026-10-19"]["failed_turns"], d["2026-10-19"]["model_requests"], d["2026-10-19"]["failed_model_requests"], d["2026-10-19"]["tool_calls"], d["2026-10-19"]["failed_tool_calls"]) == (1, 0, 2, 0, 2, 1)
        yield "day 2: 1 failed turn; 4 model requests, 1 failed; 2 tool calls failed, 1 rejected, 1 denied", (d["2026-10-20"]["failed_turns"], d["2026-10-20"]["model_requests"], d["2026-10-20"]["failed_model_requests"], d["2026-10-20"]["failed_tool_calls"], d["2026-10-20"]["rejected_tool_calls"], d["2026-10-20"]["denied_by_hook"]) == (1, 4, 1, 2, 1, 1)
    elif name == "V7":
        p = by(rows, "producer", "agent")
        mod = p[("bigquery-agent-analytics-mod", "coding-agent")]
        yield "the mod (main loop): 3 sessions, 4 model requests, 465 tokens, 26.3% rows in error", (mod["sessions"], mod["model_requests"], mod["tokens"], mod["error_row_pct"]) == (3, 4, 465, 26.3)
        yield "the mod's subagent: 1 request, 50 tokens", (p[("bigquery-agent-analytics-mod", "general-purpose")]["model_requests"], p[("bigquery-agent-analytics-mod", "general-purpose")]["tokens"]) == (1, 50)
        yield "the tracer, apart: 999 tokens", p[("bqaa-coding-agent-plugin", "coding-agent")]["tokens"] == 999
        yield "ADK, normalized: 77 tokens from total_token_count, both rows kept with no event_id", (p[("adk (no writer)", "adk-agent")]["tokens"], p[("adk (no writer)", "adk-agent")]["error_row_pct"]) == (77, 50.0)
    elif name == "1":
        yield "the mod's rows, each once: 22", len(rows) == 22
    elif name == "2":
        c = by(rows, "session_id", "model")
        yield "S1 model-a: 2 requests, 25 output tokens, cache-read share 0.294", (c[("S1", "model-a")]["model_requests"], c[("S1", "model-a")]["output_tokens"], c[("S1", "model-a")]["cache_read_share"]) == (2, 25, 0.294)
        yield "the tracer's response is not counted", ("T1", "model-a") not in c
    elif name == "3":
        m = by(rows, "model")
        yield "model-a: 4 requests (the replay once, no tracer's); model-b: 1", (m["model-a"]["requests"], m["model-b"]["requests"]) == (4, 1) and "model-c" not in m
    elif name == "4":
        t = by(rows, "tool_name")
        yield "Bash: 2 calls, 1 failure, 1 rejected at the prompt, 0 denied by a hook, 2 asked", (t["Bash"]["calls"], t["Bash"]["failures"], t["Bash"]["rejected_at_prompt"], t["Bash"]["denied_by_hook"], t["Bash"]["asked_permission"]) == (2, 1, 1, 0, 2)
        yield "WebFetch: 1 denied by a hook; no ADK tool", t["WebFetch"]["denied_by_hook"] == 1 and "search" not in t
    elif name == "5":
        t = by(rows, "invocation_id")
        yield "I1: the prompt, 2 model requests, 2 tool calls, 195 tokens", (t["I1"]["prompt"], t["I1"]["model_requests"], t["I1"]["tool_calls"], t["I1"]["turn_tokens"]) == ("list the files", 2, 2, 195)
        yield "I2: 1 subagent, and its error rows", t["I2"]["subagents"] == 1 and t["I2"]["error_rows"] == 4
    elif name == "6":
        yield "trace-1: 10 rows, each once", len(rows) == 10
        bash = [r for r in rows if r["event_type"] == "TOOL_COMPLETED" and r["detail"] == "Bash"]
        yield "the Bash call hangs under its model request", len(bash) == 1 and bash[0]["parent_event_type"] == "LLM_REQUEST"
    elif name == "7":
        a = by(rows, "subagent_type")
        yield "general-purpose: 1 run, 2.0 s, 50 tokens", set(a) == {"general-purpose"} and (a["general-purpose"]["runs"], a["general-purpose"]["avg_seconds"], a["general-purpose"]["total_tokens"]) == (1, 2.0, 50)
    elif name == "8":
        d = by(rows, "day")
        yield "day 1: 1 session, 11 rows (the replay once), 1 error", (d["2026-10-19"]["sessions"], d["2026-10-19"]["rows_written"], d["2026-10-19"]["error_rows"]) == (1, 11, 1)
        yield "day 2: 2 sessions, 11 rows, 4 errors", (d["2026-10-20"]["sessions"], d["2026-10-20"]["rows_written"], d["2026-10-20"]["error_rows"]) == (2, 11, 4)


def queries(path: Path) -> dict[str, str]:
    """Each query of a file, by its number (`-- 4.` or `-- V4.`)."""
    found, name, lines = {}, None, []
    for line in path.read_text().splitlines():
        m = re.match(r"^-- (V?\d+)\. ", line)
        if m:
            if name:
                found[name] = "\n".join(lines).strip()
            name, lines = m.group(1), []
        if name:
            lines.append(line)
    if name:
        found[name] = "\n".join(lines).strip()
    return found


def literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    text = value if isinstance(value, str) else json.dumps(value)
    return "'" + text.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> int:
    from google.cloud import bigquery

    project = os.environ.get("PROJECT")
    if not project:
        sys.exit("set PROJECT")
    dataset = f"bqaa_query_check_{secrets.token_hex(4)}"
    client = bigquery.Client(project=project)
    made = bigquery.Dataset(f"{project}.{dataset}")
    made.location = "US"
    client.create_dataset(made)
    passed = failed = 0
    try:
        # The CREATE statement alone (its descriptions hold semicolons).
        ddl = re.search(r"CREATE TABLE .*?CLUSTER BY [^;]*;", (MOD / "sql" / "agent_events_ddl.sql").read_text(), re.S).group(0)
        ddl = ddl.replace("{PROJECT}", project).replace("{DATASET}", dataset).replace("{TABLE}", "agent_events")
        client.query(ddl).result()
        values = ",\n".join(
            "(TIMESTAMP {ts}, {eid}, {et}, {agent}, {sid}, {inv}, {uid}, {trace}, {span}, {parent}, "
            "PARSE_JSON({content}), PARSE_JSON({attrs}), PARSE_JSON({lat}), {status}, {trunc})".format(
                ts=literal(r["timestamp"].replace("T", " ").replace("Z", " UTC")), eid=literal(r["event_id"]), et=literal(r["event_type"]),
                agent=literal(r["agent"]), sid=literal(r["session_id"]), inv=literal(r["invocation_id"]),
                uid=literal(r["user_id"]), trace=literal(r["trace_id"]), span=literal(r["span_id"]),
                parent=literal(r["parent_span_id"]), content=literal(r["content"]), attrs=literal(r["attributes"]),
                lat=literal(r["latency_ms"] if r["latency_ms"] is not None else {}), status=literal(r["status"]),
                trunc=literal(r["is_truncated"]))
            for r in FIXTURE)
        client.query(
            f"INSERT INTO `{project}.{dataset}.agent_events` (timestamp, event_id, event_type, agent, session_id, "
            "invocation_id, user_id, trace_id, span_id, parent_span_id, content, attributes, latency_ms, status, "
            f"is_truncated) VALUES\n{values}").result()
        client.query(f"CREATE TABLE `{project}.{dataset}.team_roster` AS "
                     f"SELECT user_id FROM UNNEST({json.dumps(ROSTER)}) AS user_id").result()
        print(f"# fixture: {len(FIXTURE)} rows in {project}.{dataset}.agent_events")
        for path in (MOD / "sql" / "value_queries.sql", MOD / "sql" / "sample_queries.sql"):
            for name, sql in queries(path).items():
                if name == "V4":
                    sql = re.sub(r"-- rates: begin.*?-- rates: end", RATES, sql, flags=re.S)
                base = [sys.executable, str(RUNNER), "--project", project, "--dataset", dataset,
                        "--table", "agent_events", "--start", START, "--end", END]
                if name == "6":
                    base += ["--trace-id", "trace-1"]
                dry = subprocess.run(base + ["--dry-run", sql], capture_output=True, text=True)
                run = subprocess.run(base + [sql], capture_output=True, text=True)
                label = f"{path.name} {name}"
                if run.returncode != 0 or dry.returncode != 0:
                    failed += 1
                    print(f"not ok - {label} runs: {(run.stderr or dry.stderr).strip()[:300]}")
                    continue
                scanned = json.loads(dry.stdout)["total_bytes_processed"]
                rows = [json.loads(line) for line in run.stdout.splitlines() if line.strip()]
                print(f"# {label}: dry run {scanned} bytes, {len(rows)} rows")
                results = checks(name, rows)
                while True:
                    try:
                        what, ok = next(results)
                    except StopIteration:
                        break
                    except Exception as error:  # a column or row the query lacks
                        failed += 1
                        print(f"not ok - {label}: the answer lacks {error!r}")
                        break
                    if ok:
                        passed += 1
                        print(f"ok - {label}: {what}")
                    else:
                        failed += 1
                        print(f"not ok - {label}: {what}")
    finally:
        client.delete_dataset(f"{project}.{dataset}", delete_contents=True, not_found_ok=True)
    print(f"{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
