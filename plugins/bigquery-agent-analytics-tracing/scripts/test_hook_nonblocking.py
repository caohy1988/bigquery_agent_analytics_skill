#!/usr/bin/env python3
"""Latency and fail-open tests for the agent hook bridge.

The agent waits for PreToolUse before it runs a tool and for PostToolUse
before it returns the result, so a slow hook stalls the agent. These tests
run the real hooks/*.sh scripts the way the agent does (JSON payload on
stdin, then wait for exit and EOF on stdout/stderr) and run the drainer
in-process. Google client libraries are replaced by a small fake package
written to a temp dir, so no network or GCP credentials are needed.
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import hashlib
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Iterator

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

import bqaa_drain  # noqa: E402
import bqaa_tracing  # noqa: E402

# The hook waits at most 1 s (BQAA_HOOK_WAIT_SECONDS); the rest is slack for
# bash and process startup on a loaded machine.
HOOK_DEADLINE_SECONDS = 3.0
# How long a stuck interpreter, ADC lookup or BigQuery request blocks.
STALL_SECONDS = 10

SESSION_ID = "session-nonblocking"
TOOL_USE_ID = "toolu_nonblocking_1"
PRE_PAYLOAD = {
    "session_id": SESSION_ID,
    "transcript_path": "",
    "cwd": "/tmp",
    "hook_event_name": "PreToolUse",
    "tool_name": "Bash",
    "tool_input": {"command": "ls -la", "description": "List files"},
    "tool_use_id": TOOL_USE_ID,
}
POST_PAYLOAD = dict(
    PRE_PAYLOAD,
    hook_event_name="PostToolUse",
    tool_response={"stdout": "ok", "stderr": "", "interrupted": False},
)
BQ_COLUMNS = {
    "timestamp",
    "event_type",
    "agent",
    "session_id",
    "invocation_id",
    "user_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "content",
    "content_parts",
    "attributes",
    "latency_ms",
    "status",
    "error_message",
    "is_truncated",
}
_CONFIG_PREFIXES = ("BQAA_", "GCP_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "BQ_DATASET", "BQ_TABLE")

# Stand-ins for the parts of google-auth / google-cloud-bigquery the plugin
# calls. Delays come from env vars so the same package works in-process and
# inside the hook subprocess (via PYTHONPATH).
FAKE_GOOGLE = {
    "google/__init__.py": "",
    "google/auth/__init__.py": '''
import os
import time

CALLS = []


class _Credentials:
    def __repr__(self):
        return "<fake ADC credentials>"


CREDENTIALS = _Credentials()


def default(scopes=None, request=None, quota_project_id=None, default_scopes=None):
    CALLS.append({"scopes": scopes, "default_scopes": default_scopes})
    time.sleep(float(os.environ.get("FAKE_GOOGLE_ADC_DELAY", "0")))
    return CREDENTIALS, "adc-project"
''',
    "google/api_core/__init__.py": "",
    "google/api_core/exceptions.py": '''
class GoogleAPICallError(Exception):
    pass


class ServiceUnavailable(GoogleAPICallError):
    pass


class TooManyRequests(GoogleAPICallError):
    pass


class InternalServerError(GoogleAPICallError):
    pass
''',
    "google/cloud/__init__.py": "",
    "google/cloud/exceptions.py": '''
class NotFound(Exception):
    pass
''',
    "google/cloud/bigquery.py": '''
import os
import time

import google.auth

CALLS = []


class SchemaField:
    def __init__(self, name, field_type, mode="NULLABLE", fields=()):
        self.name, self.field_type, self.mode, self.fields = name, field_type, mode, fields


class Dataset:
    def __init__(self, dataset_ref):
        self.dataset_id, self.location = dataset_ref, None


class Table:
    def __init__(self, table_ref, schema=None):
        self.table_id, self.schema = table_ref, schema


class TimePartitioningType:
    DAY = "DAY"


class TimePartitioning:
    def __init__(self, type_=None, field=None):
        self.type_, self.field = type_, field


class Client:
    def __init__(self, project=None, credentials=None, location=None, **kwargs):
        if credentials is None:
            # The real client resolves Application Default Credentials here.
            credentials, _ = google.auth.default(
                scopes=("https://www.googleapis.com/auth/cloud-platform",)
            )
        self.project, self.credentials, self.location = project, credentials, location

    def get_dataset(self, dataset_ref, retry=None, timeout=None):
        CALLS.append(("get_dataset", dataset_ref, timeout))
        return Dataset(dataset_ref)

    def create_dataset(self, dataset, exists_ok=False, retry=None, timeout=None):
        CALLS.append(("create_dataset", dataset.dataset_id, timeout))
        return dataset

    def get_table(self, table, retry=None, timeout=None):
        CALLS.append(("get_table", table, timeout))
        return Table(table)

    def create_table(self, table, exists_ok=False, retry=None, timeout=None):
        CALLS.append(("create_table", table.table_id, timeout))
        return table

    def insert_rows_json(self, table, json_rows, row_ids=None, skip_invalid_rows=None,
                         ignore_unknown_values=None, template_suffix=None, retry=None,
                         timeout=None):
        CALLS.append(("insert_rows_json", table, timeout, list(json_rows)))
        time.sleep(float(os.environ.get("FAKE_BIGQUERY_INSERT_DELAY", "0")))
        return []
''',
}


# ---------------------------------------------------------------------------
# Test utilities
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def _tmpdir() -> Iterator[Path]:
    with tempfile.TemporaryDirectory(prefix="bqaa-hook-test-") as raw:
        yield Path(raw)


def _base_env(tmp: Path, **overrides: str | None) -> dict[str, str]:
    """Process env with the developer's BQAA config scrubbed and all plugin
    files (log, state, spool) under tmp. A None override unsets the var."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(_CONFIG_PREFIXES)}
    env.update(
        {
            "BQAA_PYTHON": sys.executable,
            "BQAA_PROJECT_ID": "test-project",
            "BQAA_DATASET": "test_dataset",
            "BQAA_USER_ID": "test-user",
            "BQAA_LOG_FILE": str(tmp / "bqaa.log"),
            "BQAA_STATE_DIR": str(tmp / "state"),
            "BQAA_SPOOL_DIR": str(tmp / "spool"),
        }
    )
    for key, value in overrides.items():
        if value is None:
            env.pop(key, None)
        else:
            env[key] = value
    return env


@contextlib.contextmanager
def _environ(env: dict[str, str]) -> Iterator[None]:
    saved = dict(os.environ)
    os.environ.clear()
    os.environ.update(env)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


@contextlib.contextmanager
def _stdin(text: str) -> Iterator[None]:
    saved = sys.stdin
    sys.stdin = io.StringIO(text)
    try:
        yield
    finally:
        sys.stdin = saved


def _run_hook(script: str, payload: object, env: dict[str, str]) -> tuple[float, subprocess.CompletedProcess]:
    """Run hooks/<script> like the agent: payload on stdin, then wait for
    the process to exit and for EOF on stdout and stderr."""
    start = time.monotonic()
    proc = subprocess.run(
        ["bash", str(PLUGIN_ROOT / "hooks" / script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
    )
    return time.monotonic() - start, proc


def _write_stub(path: Path, body: str) -> Path:
    """An executable to use as BQAA_PYTHON in place of the real interpreter."""
    path.write_text("#!/bin/bash\n" + body + "\n", encoding="utf-8")
    path.chmod(0o755)
    return path


@contextlib.contextmanager
def _reaping(pidfile: Path) -> Iterator[Path]:
    """Kill every pid a stub recorded in pidfile once the test is done."""
    try:
        yield pidfile
    finally:
        if pidfile.exists():
            for raw in pidfile.read_text().split():
                with contextlib.suppress(ProcessLookupError, ValueError):
                    os.kill(int(raw), signal.SIGKILL)


@contextlib.contextmanager
def _drainer_lock_held(spool: Path) -> Iterator[None]:
    """Hold the drainer pidfile lock so nothing spawns a real drainer (which
    would try to reach BigQuery) while the test inspects the spool."""
    spool.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(spool / ".drainer.pid"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)


def _write_fake_google(root: Path) -> Path:
    for rel, source in FAKE_GOOGLE.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source.lstrip("\n"), encoding="utf-8")
    return root


@contextlib.contextmanager
def _fake_google_importable(root: Path) -> Iterator[None]:
    def is_google(name: str) -> bool:
        return name == "google" or name.startswith("google.")

    saved_path = list(sys.path)
    saved_modules = {k: v for k, v in sys.modules.items() if is_google(k)}
    for name in saved_modules:
        del sys.modules[name]
    sys.path.insert(0, str(_write_fake_google(root)))
    try:
        yield
    finally:
        sys.path[:] = saved_path
        for name in [k for k in sys.modules if is_google(k)]:
            del sys.modules[name]
        sys.modules.update(saved_modules)


def _spool_files(spool: Path) -> list[Path]:
    return sorted(spool.glob("event-*.json")) if spool.exists() else []


def _wait_for_spool_files(spool: Path, count: int, timeout: float) -> list[Path]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        files = _spool_files(spool)
        if len(files) >= count:
            return files
        time.sleep(0.1)
    return _spool_files(spool)


def _assert_tool_starting_envelope(path: Path) -> None:
    envelope = json.loads(path.read_text(encoding="utf-8"))
    assert envelope["config"] == {
        "project_id": "test-project",
        "dataset": "test_dataset",
        "table": "agent_events",
        "location": None,
        "auto_create_table": True,
        "auto_create_dataset": False,
        "writer_label": "bqaa-coding-agent-plugin/0.1.0",
    }, envelope["config"]
    row = envelope["row"]
    assert set(row) == BQ_COLUMNS, sorted(row)
    assert row["event_type"] == "TOOL_STARTING"
    assert row["agent"] == "claude-code"
    assert row["session_id"] == SESSION_ID
    assert row["user_id"] == "test-user"
    assert row["span_id"] == hashlib.sha256(TOOL_USE_ID.encode()).hexdigest()[:16]
    assert row["status"] == "OK"
    assert row["is_truncated"] is False
    assert json.loads(row["content"]) == {
        "args": {"command": "ls -la", "description": "List files"},
        "tool": "Bash",
        "tool_origin": "LOCAL",
    }
    assert json.loads(row["attributes"]) == {
        "source": "claude_code",
        "writer": {
            "agent": "claude-code",
            "label": "bqaa-coding-agent-plugin/0.1.0",
            "mode": "spool",
            "plugin": "bqaa-coding-agent-plugin",
            "version": "0.1.0",
        },
    }


def _spool_tool_event(config: bqaa_tracing.BQAAConfig) -> Path:
    """Spool one TOOL_STARTING row the way the hook does, without a drainer."""
    with _drainer_lock_held(Path(config.spool_dir)):
        bqaa_tracing.BigQueryAgentAnalyticsLogger(config).log_tool_starting(
            tool="Bash",
            args={"command": "ls -la"},
            session_id=SESSION_ID,
            invocation_id="i" * 32,
            trace_id="t" * 32,
            span_id="s" * 16,
            parent_span_id=None,
        )
    (path,) = _spool_files(Path(config.spool_dir))
    return path


def _dead_letters(config: bqaa_tracing.BQAAConfig) -> list[Path]:
    dead = Path(config.spool_dir) / "dead-letter"
    return sorted(dead.glob("*.json")) if dead.exists() else []


# ---------------------------------------------------------------------------
# Hook latency: the agent must never wait on Python, auth or BigQuery
# ---------------------------------------------------------------------------


def test_hook_returns_fast_when_python_cannot_start() -> None:
    # 2026-10-11: macOS syspolicyd hung, so every launch of the python.org
    # interpreter blocked until launchd replaced the daemon (up to ~20 min),
    # and the agent waited on PreToolUse/PostToolUse the whole time. A stub
    # that never gets going stands in for the blocked interpreter.
    with _tmpdir() as tmp, _reaping(tmp / "pids") as pids:
        stub = _write_stub(tmp / "stalled-python", f'echo $$ >> "{pids}"\nexec sleep {STALL_SECONDS}')
        for script, payload in (("pre_tool_use.sh", PRE_PAYLOAD), ("post_tool_use.sh", POST_PAYLOAD)):
            elapsed, proc = _run_hook(script, payload, _base_env(tmp, BQAA_PYTHON=str(stub)))
            assert elapsed < HOOK_DEADLINE_SECONDS, f"{script} held the agent for {elapsed:.1f}s"
            assert proc.returncode == 0, proc
            assert proc.stdout == "" and proc.stderr == "", proc


def test_hook_returns_fast_when_bigquery_auth_hangs() -> None:
    # With BQAA_DIRECT_WRITE=true the hook process itself talks to BigQuery;
    # building the client runs an ADC lookup that can hang (metadata server
    # probe, token refresh) and had no timeout.
    with _tmpdir() as tmp:
        env = _base_env(
            tmp,
            BQAA_DIRECT_WRITE="true",
            BQAA_NETWORK_TIMEOUT_SECONDS="1",
            FAKE_GOOGLE_ADC_DELAY=str(STALL_SECONDS),
            PYTHONPATH=str(_write_fake_google(tmp / "fake")),
        )
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, env)
        assert elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        assert proc.returncode == 0, proc
        assert proc.stdout == "" and proc.stderr == "", proc


def test_direct_write_gives_up_on_hung_auth() -> None:
    # Bounding the hook isn't enough on its own: the Python process must not
    # sit on a hung auth call either, or stuck writers pile up.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(
            tmp,
            BQAA_DIRECT_WRITE="true",
            BQAA_NETWORK_TIMEOUT_SECONDS="0.5",
            FAKE_GOOGLE_ADC_DELAY=str(STALL_SECONDS),
        )
        with _environ(env), _stdin(json.dumps(PRE_PAYLOAD)):
            start = time.monotonic()
            rc = bqaa_tracing.main(["PreToolUse"])
            elapsed = time.monotonic() - start
        assert rc == 0
        assert elapsed < 3.0, f"direct write waited {elapsed:.1f}s on a hung ADC lookup"
        assert "timed out" in (tmp / "bqaa.log").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Fail-open: errors never reach the agent
# ---------------------------------------------------------------------------


def test_hook_fails_open_when_python_fails() -> None:
    # A PreToolUse hook that exits 2 makes the agent block the tool call,
    # and any other non-zero exit or stderr output surfaces as a hook error.
    with _tmpdir() as tmp:
        cases = {
            "crash with exit 2": str(_write_stub(tmp / "crashing-python", 'echo "Traceback: boom" >&2\nexit 2')),
            "interpreter missing": str(tmp / "no-such-python"),
        }
        for label, python_bin in cases.items():
            elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_PYTHON=python_bin))
            assert proc.returncode == 0, (label, proc)
            assert proc.stdout == "" and proc.stderr == "", (label, proc)
            assert elapsed < HOOK_DEADLINE_SECONDS, (label, elapsed)


def test_main_fails_open_on_bad_input() -> None:
    cases = {
        # int("lots") used to raise from BQAAConfig.from_env(), outside
        # main()'s try block, so the hook died with a traceback.
        "malformed numeric env var": ({"BQAA_MAX_CONTENT_LENGTH": "lots"}, PRE_PAYLOAD),
        "payload is not an object": ({}, ["not", "a", "dict"]),
    }
    for label, (overrides, payload) in cases.items():
        with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
            with _environ(_base_env(tmp, **overrides)), _stdin(json.dumps(payload)):
                try:
                    rc = bqaa_tracing.main(["PreToolUse"])
                except Exception as exc:  # noqa: BLE001 - the point of the test
                    raise AssertionError(f"{label}: main() raised {exc!r}") from exc
            assert rc == 0, label
            assert "ERROR hook=PreToolUse" in (tmp / "bqaa.log").read_text(encoding="utf-8"), label


# ---------------------------------------------------------------------------
# Events still get enqueued and sent, unchanged
# ---------------------------------------------------------------------------


def test_hook_enqueues_tool_event_before_returning() -> None:
    # When Python is healthy the hook waits for it, so PreToolUse state is
    # in place before the tool runs and PostToolUse can pair with it.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        _, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_HOOK_WAIT_SECONDS="5"))
        assert proc.returncode == 0, proc
        files = _spool_files(tmp / "spool")
        assert len(files) == 1, files
        _assert_tool_starting_envelope(files[0])


def test_healthy_hook_does_not_sit_out_the_wait_and_drainer_sends() -> None:
    # The drainer outlives the hook; if it (or anything else) held the
    # hook's pipe open, every tool call would pay the full wait.
    with _tmpdir() as tmp:
        env = _base_env(tmp, PYTHONPATH=str(_write_fake_google(tmp / "fake")), BQAA_DRAIN_IDLE_SECONDS="1")
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, env)
        assert proc.returncode == 0, proc
        assert elapsed < 0.9, f"healthy hook took {elapsed:.2f}s"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and _spool_files(tmp / "spool"):
            time.sleep(0.1)
        assert _spool_files(tmp / "spool") == [], "drainer never sent the spooled event"
        assert not (tmp / "spool" / "dead-letter").exists()


def test_stalled_hook_still_enqueues_event_after_returning() -> None:
    # When Python starts late the hook returns without it; the event must
    # still land once the interpreter gets going.
    with _tmpdir() as tmp, _drainer_lock_held(tmp / "spool"):
        slow = _write_stub(tmp / "slow-python", f'sleep 5\nexec "{sys.executable}" "$@"')
        elapsed, proc = _run_hook("pre_tool_use.sh", PRE_PAYLOAD, _base_env(tmp, BQAA_PYTHON=str(slow)))
        assert elapsed < HOOK_DEADLINE_SECONDS, f"hook held the agent for {elapsed:.1f}s"
        assert proc.returncode == 0, proc
        files = _wait_for_spool_files(tmp / "spool", count=1, timeout=20)
        assert len(files) == 1, files
        _assert_tool_starting_envelope(files[0])


def test_unconfigured_hook_does_not_start_python() -> None:
    # Without a project and dataset nothing can be written (dry-run aside),
    # yet every hook still launched Python and logged a traceback.
    cases = [
        ("no project, no dataset", {"BQAA_PROJECT_ID": None, "BQAA_DATASET": None}, False),
        ("dataset only", {"BQAA_PROJECT_ID": None}, False),
        ("project only", {"BQAA_DATASET": None}, False),
        (
            "alias vars",
            {"BQAA_PROJECT_ID": None, "BQAA_DATASET": None, "GOOGLE_CLOUD_PROJECT": "p", "BQ_DATASET": "d"},
            True,
        ),
        ("dry run needs no project", {"BQAA_PROJECT_ID": None, "BQAA_DATASET": None, "BQAA_DRY_RUN": "True"}, True),
    ]
    for label, overrides, expect_python in cases:
        with _tmpdir() as tmp:
            marker = tmp / "python-started"
            stub = _write_stub(tmp / "marker-python", f'touch "{marker}"')
            _, proc = _run_hook("post_tool_use.sh", POST_PAYLOAD, _base_env(tmp, BQAA_PYTHON=str(stub), **overrides))
            assert proc.returncode == 0, (label, proc)
            deadline = time.monotonic() + (5 if expect_python else 0.5)
            while time.monotonic() < deadline and not marker.exists():
                time.sleep(0.05)
            assert marker.exists() == expect_python, label


def test_drainer_sends_spooled_row_unchanged() -> None:
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        with _environ(_base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="7")):
            config = bqaa_tracing.BQAAConfig.from_env()
            path = _spool_tool_event(config)
            spooled_row = json.loads(path.read_text(encoding="utf-8"))["row"]
            asyncio.run(bqaa_drain._drain_once(config, use_storage_api=False))
        from google.cloud import bigquery

        inserts = [call for call in bigquery.CALLS if call[0] == "insert_rows_json"]
        assert inserts == [("insert_rows_json", "test-project.test_dataset.agent_events", 7.0, [spooled_row])], inserts
        assert all(call[2] == 7.0 for call in bigquery.CALLS), bigquery.CALLS
        assert not path.exists()
        assert _dead_letters(config) == []


def test_drainer_gives_up_on_hung_auth() -> None:
    # The drainer is detached from the agent, but a hung ADC lookup pinned
    # the single drainer (and its pidfile lock) indefinitely, so nothing
    # else in the spool was written either.
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.5", FAKE_GOOGLE_ADC_DELAY=str(STALL_SECONDS))
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path = _spool_tool_event(config)
            start = time.monotonic()
            asyncio.run(bqaa_drain._drain_once(config, use_storage_api=False))
            elapsed = time.monotonic() - start
        assert elapsed < 3.0, f"drainer waited {elapsed:.1f}s on a hung ADC lookup"
        assert not path.exists()
        assert len(_dead_letters(config)) == 1


def test_drainer_gives_up_on_hung_insert() -> None:
    with _tmpdir() as tmp, _fake_google_importable(tmp / "fake"):
        env = _base_env(tmp, BQAA_NETWORK_TIMEOUT_SECONDS="0.5", FAKE_BIGQUERY_INSERT_DELAY=str(STALL_SECONDS))
        with _environ(env):
            config = bqaa_tracing.BQAAConfig.from_env()
            path = _spool_tool_event(config)
            envelope = bqaa_drain._read_envelope(path)
            ((key, batch),) = bqaa_drain._group_envelopes([envelope]).items()
            start = time.monotonic()
            asyncio.run(
                bqaa_drain._drain_group_async(
                    key=key,
                    envelopes=batch,
                    retry=bqaa_drain._RetryConfig(max_retries=0),
                    config=config,
                    use_storage_api=False,
                )
            )
            elapsed = time.monotonic() - start
        assert elapsed < 3.0, f"drainer waited {elapsed:.1f}s on a hung insert"
        assert not path.exists()
        assert len(_dead_letters(config)) == 1


def main() -> int:
    for test in (
        test_hook_returns_fast_when_python_cannot_start,
        test_hook_returns_fast_when_bigquery_auth_hangs,
        test_direct_write_gives_up_on_hung_auth,
        test_hook_fails_open_when_python_fails,
        test_main_fails_open_on_bad_input,
        test_hook_enqueues_tool_event_before_returning,
        test_healthy_hook_does_not_sit_out_the_wait_and_drainer_sends,
        test_stalled_hook_still_enqueues_event_after_returning,
        test_unconfigured_hook_does_not_start_python,
        test_drainer_sends_spooled_row_unchanged,
        test_drainer_gives_up_on_hung_auth,
        test_drainer_gives_up_on_hung_insert,
    ):
        test()
    print("hook nonblocking tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
