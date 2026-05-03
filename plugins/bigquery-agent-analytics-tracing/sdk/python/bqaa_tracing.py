from __future__ import annotations

import json
import os
import sys
import time
import traceback
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


BQAA_EVENT_TYPES = {
    "LLM_REQUEST",
    "LLM_RESPONSE",
    "TOOL_STARTING",
    "TOOL_COMPLETED",
    "HITL_CREDENTIAL_REQUEST",
    "HITL_CREDENTIAL_REQUEST_COMPLETED",
    "HITL_CONFIRMATION_REQUEST",
    "HITL_CONFIRMATION_REQUEST_COMPLETED",
    "HITL_INPUT_REQUEST",
    "HITL_INPUT_REQUEST_COMPLETED",
    "STATE_DELTA",
}

SENSITIVE_KEYS = {
    "api_key",
    "authorization",
    "client_secret",
    "id_token",
    "password",
    "refresh_token",
    "secret",
    "token",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _timestamp_ms() -> int:
    return int(time.time() * 1000)


def _iso_timestamp(value: datetime | None = None) -> str:
    ts = value or _utc_now()
    return ts.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _hex_id(chars: int) -> str:
    return uuid.uuid4().hex[:chars]


def _to_jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_to_jsonable(v) for v in value]
    if hasattr(value, "model_dump"):
        return _to_jsonable(value.model_dump())
    if hasattr(value, "to_dict"):
        return _to_jsonable(value.to_dict())
    return str(value)


def _truncate(value: Any, max_len: int) -> tuple[Any, bool]:
    value = _to_jsonable(value)
    if max_len == -1:
        return value, False
    if isinstance(value, str):
        if len(value) > max_len:
            return value[:max_len] + "...[TRUNCATED]", True
        return value, False
    if isinstance(value, list):
        out = []
        truncated = False
        for item in value:
            next_item, did_truncate = _truncate(item, max_len)
            out.append(next_item)
            truncated = truncated or did_truncate
        return out, truncated
    if isinstance(value, dict):
        out = {}
        truncated = False
        for key, item in value.items():
            key_lower = str(key).lower()
            if key_lower in SENSITIVE_KEYS or key_lower.startswith("temp:"):
                out[key] = "[REDACTED]"
                continue
            next_item, did_truncate = _truncate(item, max_len)
            out[key] = next_item
            truncated = truncated or did_truncate
        return out, truncated
    return value, False


def _safe_json_loads(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        pieces = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                pieces.append(str(item.get("text", "")))
            elif isinstance(item, str):
                pieces.append(item)
        return "\n".join(p for p in pieces if p)
    return ""


def _read_transcript_since(path: str, start_line: int) -> tuple[str, str, dict[str, int]]:
    output_parts: list[str] = []
    model = ""
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if not path:
        return "", model, usage
    transcript = Path(path).expanduser()
    if not transcript.exists():
        return "", model, usage

    with transcript.open("r", encoding="utf-8", errors="replace") as handle:
        for line_no, line in enumerate(handle, start=1):
            if line_no <= start_line or not line.strip():
                continue
            item = _safe_json_loads(line, {})
            if item.get("type") != "assistant":
                continue
            message = item.get("message") or {}
            model = message.get("model") or model
            text = _text_from_content(message.get("content"))
            if text:
                output_parts.append(text)
            raw_usage = message.get("usage") or {}
            usage["prompt_tokens"] += int(raw_usage.get("input_tokens") or 0)
            usage["prompt_tokens"] += int(raw_usage.get("cache_read_input_tokens") or 0)
            usage["prompt_tokens"] += int(raw_usage.get("cache_creation_input_tokens") or 0)
            usage["completion_tokens"] += int(raw_usage.get("output_tokens") or 0)
    usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
    return "\n".join(output_parts), model, usage


@dataclass
class BQAAConfig:
    project_id: str
    dataset: str
    table: str = "agent_events"
    agent_name: str = "coding-agent"
    user_id: str = "local-user"
    enabled: bool = True
    dry_run: bool = False
    auto_create_table: bool = True
    auto_create_dataset: bool = False
    location: str | None = None
    max_content_length: int = 5000
    log_file: str = "/tmp/bqaa-agent-tracing.log"

    @classmethod
    def from_env(cls) -> "BQAAConfig":
        return cls(
            project_id=os.environ.get("BQAA_PROJECT_ID")
            or os.environ.get("GCP_PROJECT_ID")
            or os.environ.get("GOOGLE_CLOUD_PROJECT")
            or "",
            dataset=os.environ.get("BQAA_DATASET") or os.environ.get("BQ_DATASET") or "",
            table=os.environ.get("BQAA_TABLE") or os.environ.get("BQ_TABLE") or "agent_events",
            agent_name=os.environ.get("BQAA_AGENT_NAME") or "coding-agent",
            user_id=os.environ.get("BQAA_USER_ID") or os.environ.get("USER") or "local-user",
            enabled=os.environ.get("BQAA_TRACE_ENABLED", "true").lower() == "true",
            dry_run=os.environ.get("BQAA_DRY_RUN", "false").lower() == "true",
            auto_create_table=os.environ.get("BQAA_AUTO_CREATE_TABLE", "true").lower()
            == "true",
            auto_create_dataset=os.environ.get("BQAA_AUTO_CREATE_DATASET", "false").lower()
            == "true",
            location=os.environ.get("BQAA_LOCATION") or None,
            max_content_length=int(os.environ.get("BQAA_MAX_CONTENT_LENGTH", "5000")),
            log_file=os.environ.get("BQAA_LOG_FILE", "/tmp/bqaa-agent-tracing.log"),
        )


class BigQueryAgentAnalyticsLogger:
    def __init__(self, config: BQAAConfig | None = None):
        self.config = config or BQAAConfig.from_env()
        self._client = None
        self._table_ready = False

    def log_event(
        self,
        *,
        event_type: str,
        content: dict[str, Any] | None = None,
        attributes: dict[str, Any] | None = None,
        latency_ms: dict[str, Any] | None = None,
        agent: str | None = None,
        session_id: str | None = None,
        invocation_id: str | None = None,
        user_id: str | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        status: str = "OK",
        error_message: str | None = None,
        timestamp: datetime | None = None,
        content_parts: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        if not self.config.enabled:
            return {}
        if event_type not in BQAA_EVENT_TYPES:
            raise ValueError(f"Unsupported BQAA event_type: {event_type}")

        clipped_content, content_truncated = _truncate(
            content or {}, self.config.max_content_length
        )
        clipped_attributes, attr_truncated = _truncate(
            attributes or {}, self.config.max_content_length
        )
        clipped_latency, latency_truncated = _truncate(latency_ms or {}, 1000)
        clipped_parts, parts_truncated = _truncate(
            content_parts or [], self.config.max_content_length
        )

        row = {
            "timestamp": _iso_timestamp(timestamp),
            "event_type": event_type,
            "agent": agent or self.config.agent_name,
            "session_id": session_id,
            "invocation_id": invocation_id,
            "user_id": user_id or self.config.user_id,
            "trace_id": trace_id,
            "span_id": span_id or _hex_id(16),
            "parent_span_id": parent_span_id,
            "content": clipped_content,
            "content_parts": clipped_parts,
            "attributes": clipped_attributes,
            "latency_ms": clipped_latency,
            "status": status,
            "error_message": error_message,
            "is_truncated": bool(
                content_truncated
                or attr_truncated
                or latency_truncated
                or parts_truncated
            ),
        }
        self._write_row(row)
        return row

    def log_llm_request(
        self,
        *,
        prompt: str,
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None = None,
        agent: str | None = None,
        user_id: str | None = None,
        system_prompt: str | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        return self.log_event(
            event_type="LLM_REQUEST",
            agent=agent,
            user_id=user_id,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={
                "system_prompt": system_prompt or "",
                "prompt": [{"role": "user", "content": prompt}],
            },
            content_parts=[_content_part(prompt, 0)] if prompt else [],
            attributes=attributes,
        )

    def log_llm_response(
        self,
        *,
        response: str,
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None = None,
        agent: str | None = None,
        user_id: str | None = None,
        model: str | None = None,
        usage_metadata: dict[str, int] | None = None,
        total_ms: int | None = None,
        status: str = "OK",
        error_message: str | None = None,
        attributes: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        usage = usage_metadata or {}
        attrs = {
            "model": model or "",
            "usage_metadata": {
                "prompt_tokens": int(usage.get("prompt_tokens") or 0),
                "completion_tokens": int(usage.get("completion_tokens") or 0),
                "total_tokens": int(usage.get("total_tokens") or 0),
            },
        }
        if attributes:
            attrs.update(attributes)
        return self.log_event(
            event_type="LLM_RESPONSE",
            agent=agent,
            user_id=user_id,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"response": response},
            content_parts=[_content_part(response, 0)] if response else [],
            attributes=attrs,
            latency_ms={"total_ms": total_ms} if total_ms is not None else {},
            status=status,
            error_message=error_message,
        )

    def log_tool_starting(
        self,
        *,
        tool: str,
        args: dict[str, Any],
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None,
        agent: str | None = None,
        tool_origin: str = "LOCAL",
    ) -> dict[str, Any]:
        return self.log_event(
            event_type="TOOL_STARTING",
            agent=agent,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"tool": tool, "args": args, "tool_origin": tool_origin},
            attributes={"source": "claude_code"},
        )

    def log_tool_completed(
        self,
        *,
        tool: str,
        result: Any,
        session_id: str,
        invocation_id: str,
        trace_id: str,
        span_id: str,
        parent_span_id: str | None,
        agent: str | None = None,
        tool_origin: str = "LOCAL",
        total_ms: int | None = None,
        status: str = "OK",
        error_message: str | None = None,
    ) -> dict[str, Any]:
        return self.log_event(
            event_type="TOOL_COMPLETED",
            agent=agent,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"tool": tool, "result": result, "tool_origin": tool_origin},
            attributes={"source": "claude_code"},
            latency_ms={"total_ms": total_ms} if total_ms is not None else {},
            status=status,
            error_message=error_message,
        )

    def _write_row(self, row: dict[str, Any]) -> None:
        bq_row = _serialize_bq_json_fields(row)
        if self.config.dry_run:
            _log(self.config, "DRY_RUN " + json.dumps(bq_row, sort_keys=True, default=str))
            return
        if not self.config.project_id or not self.config.dataset:
            raise ValueError("BQAA_PROJECT_ID/GCP_PROJECT_ID and BQAA_DATASET are required")
        self._ensure_table()
        errors = self._client.insert_rows_json(self._table_id, [bq_row])
        if errors:
            raise RuntimeError(f"BigQuery insert failed: {errors}")

    def _ensure_table(self) -> None:
        if self._table_ready:
            return
        from google.cloud import bigquery
        from google.cloud.exceptions import NotFound

        self._client = self._client or bigquery.Client(
            project=self.config.project_id, location=self.config.location
        )
        dataset_id = f"{self.config.project_id}.{self.config.dataset}"
        if self.config.auto_create_dataset:
            try:
                self._client.get_dataset(dataset_id)
            except NotFound:
                dataset = bigquery.Dataset(dataset_id)
                if self.config.location:
                    dataset.location = self.config.location
                self._client.create_dataset(dataset)

        try:
            self._client.get_table(self._table_id)
        except NotFound:
            if not self.config.auto_create_table:
                raise
            table = bigquery.Table(self._table_id, schema=_bq_schema(bigquery))
            table.time_partitioning = bigquery.TimePartitioning(
                type_=bigquery.TimePartitioningType.DAY,
                field="timestamp",
            )
            table.clustering_fields = ["event_type", "agent", "user_id"]
            table.labels = {"adk_schema_version": "1"}
            self._client.create_table(table)
        self._table_ready = True

    @property
    def _table_id(self) -> str:
        return f"{self.config.project_id}.{self.config.dataset}.{self.config.table}"


def _content_part(text: str, index: int) -> dict[str, Any]:
    return {
        "mime_type": "text/plain",
        "uri": None,
        "object_ref": None,
        "text": text,
        "part_index": index,
        "part_attributes": None,
        "storage_mode": "INLINE",
    }


def _serialize_bq_json_fields(row: dict[str, Any]) -> dict[str, Any]:
    bq_row = dict(row)
    for field in ("content", "attributes", "latency_ms"):
        value = bq_row.get(field)
        if value is not None and not isinstance(value, str):
            bq_row[field] = json.dumps(value, sort_keys=True)
    parts = []
    for part in bq_row.get("content_parts") or []:
        next_part = dict(part)
        object_ref = next_part.get("object_ref")
        if isinstance(object_ref, dict):
            details = object_ref.get("details")
            if details is not None and not isinstance(details, str):
                next_object_ref = dict(object_ref)
                next_object_ref["details"] = json.dumps(details, sort_keys=True)
                next_part["object_ref"] = next_object_ref
        parts.append(next_part)
    bq_row["content_parts"] = parts
    return bq_row


def _bq_schema(bigquery: Any) -> list[Any]:
    return [
        bigquery.SchemaField("timestamp", "TIMESTAMP", mode="REQUIRED"),
        bigquery.SchemaField("event_type", "STRING"),
        bigquery.SchemaField("agent", "STRING"),
        bigquery.SchemaField("session_id", "STRING"),
        bigquery.SchemaField("invocation_id", "STRING"),
        bigquery.SchemaField("user_id", "STRING"),
        bigquery.SchemaField("trace_id", "STRING"),
        bigquery.SchemaField("span_id", "STRING"),
        bigquery.SchemaField("parent_span_id", "STRING"),
        bigquery.SchemaField("content", "JSON"),
        bigquery.SchemaField(
            "content_parts",
            "RECORD",
            mode="REPEATED",
            fields=[
                bigquery.SchemaField("mime_type", "STRING"),
                bigquery.SchemaField("uri", "STRING"),
                bigquery.SchemaField(
                    "object_ref",
                    "RECORD",
                    fields=[
                        bigquery.SchemaField("uri", "STRING"),
                        bigquery.SchemaField("version", "STRING"),
                        bigquery.SchemaField("authorizer", "STRING"),
                        bigquery.SchemaField("details", "JSON"),
                    ],
                ),
                bigquery.SchemaField("text", "STRING"),
                bigquery.SchemaField("part_index", "INTEGER"),
                bigquery.SchemaField("part_attributes", "STRING"),
                bigquery.SchemaField("storage_mode", "STRING"),
            ],
        ),
        bigquery.SchemaField("attributes", "JSON"),
        bigquery.SchemaField("latency_ms", "JSON"),
        bigquery.SchemaField("status", "STRING"),
        bigquery.SchemaField("error_message", "STRING"),
        bigquery.SchemaField("is_truncated", "BOOLEAN"),
    ]


class StateStore:
    def __init__(self, key: str):
        safe_key = "".join(ch for ch in key if ch.isalnum() or ch in "._-") or "default"
        root = Path(os.environ.get("BQAA_STATE_DIR", "/tmp/bqaa-agent-tracing")).expanduser()
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / f"state_{safe_key}.json"
        self.state = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}

    def get(self, key: str, default: Any = None) -> Any:
        return self.state.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.state[key] = value
        self.save()

    def update(self, values: dict[str, Any]) -> None:
        self.state.update(values)
        self.save()

    def delete(self, *keys: str) -> None:
        for key in keys:
            self.state.pop(key, None)
        self.save()

    def save(self) -> None:
        tmp = self.path.with_suffix(f".{os.getpid()}.tmp")
        tmp.write_text(json.dumps(self.state, sort_keys=True), encoding="utf-8")
        os.replace(tmp, self.path)

    def remove(self) -> None:
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


class ClaudeHookBQAAAdapter:
    def __init__(self, logger: BigQueryAgentAnalyticsLogger | None = None):
        self.logger = logger or BigQueryAgentAnalyticsLogger()
        self.config = self.logger.config

    def process(self, hook_name: str, payload: dict[str, Any]) -> None:
        state = StateStore(self._state_key(payload))
        if hook_name == "SessionStart":
            self._session_start(payload, state)
        elif hook_name == "UserPromptSubmit":
            self._user_prompt_submit(payload, state)
        elif hook_name == "PreToolUse":
            self._pre_tool_use(payload, state)
        elif hook_name == "PostToolUse":
            self._post_tool_use(payload, state)
        elif hook_name == "Stop":
            self._stop(payload, state)
        elif hook_name == "SubagentStop":
            self._subagent_stop(payload, state)
        elif hook_name == "Notification":
            self._notification(payload, state)
        elif hook_name == "PermissionRequest":
            self._permission_request(payload, state)
        elif hook_name == "SessionEnd":
            self._session_end(payload, state)

    def _state_key(self, payload: dict[str, Any]) -> str:
        return (
            str(payload.get("session_id") or "")
            or os.environ.get("CLAUDE_SESSION_KEY", "")
            or str(os.getppid())
        )

    def _ensure_session(self, payload: dict[str, Any], state: StateStore) -> None:
        if state.get("session_id"):
            return
        self._session_start(payload, state)

    def _session_start(self, payload: dict[str, Any], state: StateStore) -> None:
        cwd = payload.get("cwd") or os.getcwd()
        session_id = payload.get("session_id") or _hex_id(32)
        state.update(
            {
                "session_id": session_id,
                "project_name": os.environ.get("BQAA_PROJECT_NAME") or Path(cwd).name,
                "agent": os.environ.get("BQAA_AGENT_NAME") or "claude-code",
                "user_id": os.environ.get("BQAA_USER_ID") or os.environ.get("USER"),
                "trace_count": int(state.get("trace_count", 0)),
                "session_start_ms": _timestamp_ms(),
            }
        )

    def _user_prompt_submit(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        trace_count = int(state.get("trace_count", 0)) + 1
        trace_id = _hex_id(32)
        span_id = _hex_id(16)
        invocation_id = payload.get("invocation_id") or _hex_id(32)
        prompt = str(payload.get("prompt") or "")
        transcript = str(payload.get("transcript_path") or "")
        state.update(
            {
                "trace_count": trace_count,
                "current_trace_id": trace_id,
                "current_span_id": span_id,
                "current_invocation_id": invocation_id,
                "current_prompt": prompt,
                "current_start_ms": _timestamp_ms(),
                "transcript_path": transcript,
                "transcript_start_line": _line_count(transcript),
            }
        )
        self.logger.log_llm_request(
            prompt=prompt,
            session_id=state.get("session_id"),
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            agent=state.get("agent"),
            user_id=state.get("user_id"),
            attributes={
                "session_metadata": {
                    "project_name": state.get("project_name"),
                    "cwd": payload.get("cwd"),
                    "source": "claude_code",
                    "trace_number": trace_count,
                },
                "custom_tags": {"assistant": "claude_code"},
            },
        )

    def _pre_tool_use(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        tool_id = str(payload.get("tool_use_id") or _hex_id(16))
        span_id = _hex_id(16)
        key = f"tool_{tool_id}"
        state.set(
            key,
            {
                "start_ms": _timestamp_ms(),
                "span_id": span_id,
                "tool_name": payload.get("tool_name") or "unknown",
            },
        )
        self.logger.log_tool_starting(
            tool=str(payload.get("tool_name") or "unknown"),
            args=_to_jsonable(payload.get("tool_input") or {}),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id") or _hex_id(32),
            trace_id=state.get("current_trace_id") or _hex_id(32),
            span_id=span_id,
            parent_span_id=state.get("current_span_id"),
            agent=state.get("agent"),
            tool_origin=_tool_origin(payload.get("tool_name")),
        )

    def _post_tool_use(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        tool_id = str(payload.get("tool_use_id") or "")
        key = f"tool_{tool_id}"
        tool_state = state.get(key, {}) if tool_id else {}
        start_ms = int(tool_state.get("start_ms") or _timestamp_ms())
        tool_name = str(payload.get("tool_name") or tool_state.get("tool_name") or "unknown")
        result = payload.get("tool_response")
        status, error_message = _tool_status(result)
        self.logger.log_tool_completed(
            tool=tool_name,
            result=_to_jsonable(result),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id") or _hex_id(32),
            trace_id=state.get("current_trace_id") or _hex_id(32),
            span_id=tool_state.get("span_id") or _hex_id(16),
            parent_span_id=state.get("current_span_id"),
            agent=state.get("agent"),
            tool_origin=_tool_origin(tool_name),
            total_ms=max(0, _timestamp_ms() - start_ms),
            status=status,
            error_message=error_message,
        )
        if tool_id:
            state.delete(key)

    def _stop(self, payload: dict[str, Any], state: StateStore) -> None:
        if not state.get("current_trace_id"):
            return
        transcript = str(payload.get("transcript_path") or state.get("transcript_path") or "")
        output, model, usage = _read_transcript_since(
            transcript, int(state.get("transcript_start_line") or 0)
        )
        output = output or str(payload.get("response") or "(No response captured)")
        start_ms = int(state.get("current_start_ms") or _timestamp_ms())
        self.logger.log_llm_response(
            response=output,
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=state.get("current_span_id"),
            agent=state.get("agent"),
            user_id=state.get("user_id"),
            model=model or str(payload.get("model") or ""),
            usage_metadata=usage,
            total_ms=max(0, _timestamp_ms() - start_ms),
            attributes={
                "session_metadata": {
                    "project_name": state.get("project_name"),
                    "source": "claude_code",
                    "trace_number": state.get("trace_count"),
                },
                "custom_tags": {"assistant": "claude_code"},
            },
        )
        state.delete(
            "current_trace_id",
            "current_span_id",
            "current_invocation_id",
            "current_prompt",
            "current_start_ms",
            "transcript_path",
            "transcript_start_line",
        )

    def _subagent_stop(self, payload: dict[str, Any], state: StateStore) -> None:
        if not state.get("current_trace_id"):
            return
        transcript = str(payload.get("agent_transcript_path") or "")
        output, model, usage = _read_transcript_since(transcript, 0)
        agent_name = str(payload.get("agent_type") or payload.get("agent_id") or "subagent")
        self.logger.log_llm_response(
            response=output or str(payload.get("output") or ""),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            agent=agent_name,
            user_id=state.get("user_id"),
            model=model,
            usage_metadata=usage,
            attributes={
                "session_metadata": {
                    "project_name": state.get("project_name"),
                    "source": "claude_code_subagent",
                },
                "custom_tags": {
                    "assistant": "claude_code",
                    "subagent_id": payload.get("agent_id"),
                },
            },
        )

    def _notification(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        self.logger.log_event(
            event_type="STATE_DELTA",
            agent=state.get("agent"),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            content={
                "notification": {
                    "title": payload.get("title"),
                    "message": payload.get("message"),
                    "type": payload.get("notification_type") or "info",
                }
            },
            attributes={
                "state_delta": {
                    "source": "claude_code_notification",
                    "notification_type": payload.get("notification_type") or "info",
                }
            },
        )

    def _permission_request(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        self.logger.log_event(
            event_type="HITL_CONFIRMATION_REQUEST",
            agent=state.get("agent"),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            content={
                "permission": payload.get("permission"),
                "tool": payload.get("tool_name"),
                "args": _to_jsonable(payload.get("tool_input") or {}),
            },
            attributes={
                "session_metadata": {"source": "claude_code_permission_request"},
                "custom_tags": {"assistant": "claude_code"},
            },
        )

    def _session_end(self, payload: dict[str, Any], state: StateStore) -> None:
        self._ensure_session(payload, state)
        self.logger.log_event(
            event_type="STATE_DELTA",
            agent=state.get("agent"),
            session_id=state.get("session_id"),
            invocation_id=state.get("current_invocation_id"),
            trace_id=state.get("current_trace_id"),
            span_id=_hex_id(16),
            parent_span_id=state.get("current_span_id"),
            content={"session_end": True},
            attributes={
                "state_delta": {
                    "source": "claude_code_session_end",
                    "trace_count": state.get("trace_count", 0),
                    "duration_ms": max(
                        0, _timestamp_ms() - int(state.get("session_start_ms") or _timestamp_ms())
                    ),
                }
            },
        )
        state.remove()


def _line_count(path: str) -> int:
    if not path:
        return 0
    transcript = Path(path).expanduser()
    if not transcript.exists():
        return 0
    with transcript.open("r", encoding="utf-8", errors="replace") as handle:
        return sum(1 for _ in handle)


def _tool_origin(tool_name: Any) -> str:
    name = str(tool_name or "")
    if name.lower().startswith("mcp__"):
        return "MCP"
    if name in {"Task", "Subagent"}:
        return "SUB_AGENT"
    return "LOCAL"


def _tool_status(result: Any) -> tuple[str, str | None]:
    if isinstance(result, dict):
        if result.get("is_error") or result.get("error"):
            return "ERROR", str(result.get("error") or result.get("message") or "tool error")
    text = str(result or "")
    if text.lower().startswith("error:"):
        return "ERROR", text[:1000]
    return "OK", None


def _log(config: BQAAConfig, message: str) -> None:
    if not config.log_file:
        return
    try:
        with open(config.log_file, "a", encoding="utf-8") as handle:
            handle.write(f"[{_iso_timestamp()}] {message}\n")
    except OSError:
        pass


def run_claude_hook(hook_name: str, payload: dict[str, Any] | None = None) -> None:
    adapter = ClaudeHookBQAAAdapter()
    adapter.process(hook_name, payload or {})


def main(argv: list[str] | None = None) -> int:
    argv = argv or sys.argv[1:]
    if not argv:
        print("usage: bqaa_tracing.py <ClaudeHookName>", file=sys.stderr)
        return 2
    hook_name = argv[0]
    raw = sys.stdin.read()
    payload = _safe_json_loads(raw, {}) if raw.strip() else {}
    config = BQAAConfig.from_env()
    try:
        ClaudeHookBQAAAdapter(BigQueryAgentAnalyticsLogger(config)).process(
            hook_name, payload
        )
    except Exception as exc:  # Hooks should never break the calling agent.
        _log(config, f"ERROR hook={hook_name}: {exc}\n{traceback.format_exc()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
