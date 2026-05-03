"""OpenAI Agents SDK tracing processor for BQAA.

The OpenAI Agents SDK exposes custom tracing through `TracingProcessor` plus
`add_trace_processor()` / `set_trace_processors()`. This module keeps that
dependency optional: import it only in runtimes that install `openai-agents`.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from bqaa_tracing import BQAAConfig
from bqaa_tracing import BigQueryAgentAnalyticsLogger
from bqaa_tracing import _to_jsonable

try:
    from agents.tracing import TracingProcessor
except ImportError as exc:  # pragma: no cover - exercised when optional dep absent.
    raise ImportError(
        "BQAAOpenAIAgentsProcessor requires the optional `openai-agents` package. "
        "Install it with `pip install openai-agents`."
    ) from exc


class BQAAOpenAIAgentsProcessor(TracingProcessor):
    """Exports OpenAI Agents SDK traces/spans as BQAA rows.

    `generation` spans become paired `LLM_REQUEST` / `LLM_RESPONSE` events.
    `function` spans become paired `TOOL_STARTING` / `TOOL_COMPLETED` events.
    Other span types are emitted as `STATE_DELTA` so the trace remains visible
    without inventing unsupported BQAA event types.
    """

    def __init__(
        self,
        logger: BigQueryAgentAnalyticsLogger | None = None,
        *,
        agent_name: str | None = None,
        user_id: str | None = None,
    ):
        self.logger = logger or BigQueryAgentAnalyticsLogger()
        self.config = self.logger.config
        self.agent_name = agent_name or self.config.agent_name or "openai-agents"
        self.user_id = user_id or self.config.user_id
        self._traces: dict[str, dict[str, Any]] = {}

    def on_trace_start(self, trace: Any) -> None:
        exported = _export(trace)
        trace_id = str(exported.get("trace_id") or _attr(trace, "trace_id") or "")
        self._traces[trace_id] = exported

    def on_trace_end(self, trace: Any) -> None:
        exported = _export(trace)
        trace_id = str(exported.get("trace_id") or _attr(trace, "trace_id") or "")
        self._traces.pop(trace_id, None)

    def on_span_start(self, span: Any) -> None:
        return None

    def on_span_end(self, span: Any) -> None:
        exported = _export(span)
        span_data = exported.get("span_data") or {}
        span_type = span_data.get("type") or "unknown"
        if span_type == "generation":
            self._log_generation_span(exported, span_data)
        elif span_type == "function":
            self._log_function_span(exported, span_data)
        else:
            self._log_state_span(exported, span_data)

    def shutdown(self) -> None:
        self.force_flush()
        self._traces.clear()

    def force_flush(self) -> None:
        # BigQueryAgentAnalyticsLogger already writes direct or spools
        # synchronously per call; there is no in-process queue to flush here.
        return None

    def _log_generation_span(
        self, exported: dict[str, Any], span_data: dict[str, Any]
    ) -> None:
        trace_id = _trace_id(exported)
        span_id = _span_id(exported.get("id"))
        parent_span_id = _span_id(exported.get("parent_id"))
        invocation_id = trace_id
        session_id = self._session_id(exported)
        started_at = _parse_ts(exported.get("started_at"))
        ended_at = _parse_ts(exported.get("ended_at"))
        prompt = _text(span_data.get("input"))
        response = _text(span_data.get("output"))
        usage = _usage(span_data.get("usage"))

        self.logger.log_event(
            event_type="LLM_REQUEST",
            agent=self.agent_name,
            user_id=self.user_id,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            content={"system_prompt": "", "prompt": [{"role": "user", "content": prompt}]},
            attributes={
                "model": span_data.get("model") or "",
                "session_metadata": {
                    "source": "openai_agents_sdk",
                    "span_type": "generation",
                },
                "custom_tags": {"assistant": "openai_agents"},
            },
            timestamp=started_at,
        )
        self.logger.log_llm_response(
            response=response,
            agent=self.agent_name,
            user_id=self.user_id,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            model=str(span_data.get("model") or ""),
            usage_metadata=usage,
            total_ms=_duration_ms(started_at, ended_at),
            status="ERROR" if exported.get("error") else "OK",
            error_message=_error_message(exported.get("error")),
            attributes={
                "session_metadata": {
                    "source": "openai_agents_sdk",
                    "span_type": "generation",
                },
                "custom_tags": {"assistant": "openai_agents"},
            },
        )

    def _log_function_span(
        self, exported: dict[str, Any], span_data: dict[str, Any]
    ) -> None:
        trace_id = _trace_id(exported)
        span_id = _span_id(exported.get("id"))
        parent_span_id = _span_id(exported.get("parent_id"))
        invocation_id = trace_id
        session_id = self._session_id(exported)
        started_at = _parse_ts(exported.get("started_at"))
        ended_at = _parse_ts(exported.get("ended_at"))
        tool_name = str(span_data.get("name") or "function")

        attrs = {
            "source": "openai_agents_sdk",
            "session_metadata": {
                "source": "openai_agents_sdk",
                "span_type": "function",
            },
            "custom_tags": {"assistant": "openai_agents"},
        }
        self.logger.log_tool_starting(
            tool=tool_name,
            args=_to_jsonable(span_data.get("input") or {}),
            agent=self.agent_name,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            tool_origin="OPENAI_AGENTS",
            attributes=attrs,
        )
        self.logger.log_tool_completed(
            tool=tool_name,
            result=_to_jsonable(span_data.get("output")),
            agent=self.agent_name,
            session_id=session_id,
            invocation_id=invocation_id,
            trace_id=trace_id,
            span_id=span_id,
            parent_span_id=parent_span_id,
            tool_origin="OPENAI_AGENTS",
            total_ms=_duration_ms(started_at, ended_at),
            status="ERROR" if exported.get("error") else "OK",
            error_message=_error_message(exported.get("error")),
            attributes=attrs,
        )

    def _log_state_span(self, exported: dict[str, Any], span_data: dict[str, Any]) -> None:
        trace_id = _trace_id(exported)
        self.logger.log_event(
            event_type="STATE_DELTA",
            agent=self.agent_name,
            user_id=self.user_id,
            session_id=self._session_id(exported),
            invocation_id=trace_id,
            trace_id=trace_id,
            span_id=_span_id(exported.get("id")),
            parent_span_id=_span_id(exported.get("parent_id")),
            content={"span": span_data},
            attributes={
                "state_delta": {
                    "source": "openai_agents_sdk",
                    "span_type": span_data.get("type") or "unknown",
                },
                "custom_tags": {"assistant": "openai_agents"},
            },
            status="ERROR" if exported.get("error") else "OK",
            error_message=_error_message(exported.get("error")),
        )

    def _session_id(self, exported: dict[str, Any]) -> str:
        trace_id = str(exported.get("trace_id") or "")
        trace_meta = self._traces.get(trace_id, {})
        group_id = trace_meta.get("group_id") or trace_meta.get("group")
        return str(group_id or trace_id or "openai-agents-session")


def add_bqaa_trace_processor(
    logger: BigQueryAgentAnalyticsLogger | None = None,
    *,
    agent_name: str | None = None,
    user_id: str | None = None,
) -> BQAAOpenAIAgentsProcessor:
    """Register this exporter with OpenAI Agents SDK tracing.

    Uses `add_trace_processor()` so the default OpenAI trace exporter remains
    installed. Use `agents.tracing.set_trace_processors([processor])` yourself
    if you intentionally want to replace the default processors.
    """
    from agents.tracing import add_trace_processor

    processor = BQAAOpenAIAgentsProcessor(
        logger=logger, agent_name=agent_name, user_id=user_id
    )
    add_trace_processor(processor)
    return processor


def _export(item: Any) -> dict[str, Any]:
    exported = item.export() if hasattr(item, "export") else {}
    return exported if isinstance(exported, dict) else {}


def _attr(item: Any, name: str) -> Any:
    return getattr(item, name, None)


def _parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _duration_ms(started_at: datetime | None, ended_at: datetime | None) -> int | None:
    if not started_at or not ended_at:
        return None
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    if ended_at.tzinfo is None:
        ended_at = ended_at.replace(tzinfo=timezone.utc)
    return max(0, int((ended_at - started_at).total_seconds() * 1000))


def _stable_hex(value: Any, chars: int) -> str:
    text = str(value or "")
    if len(text) >= chars and all(ch in "0123456789abcdef" for ch in text[:chars].lower()):
        return text[:chars].lower()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:chars]


def _trace_id(exported: dict[str, Any]) -> str:
    return _stable_hex(exported.get("trace_id") or "openai-agents-trace", 32)


def _span_id(value: Any) -> str | None:
    if not value:
        return None
    return _stable_hex(value, 16)


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return str(_to_jsonable(value))


def _usage(value: Any) -> dict[str, int]:
    usage = _to_jsonable(value) if value is not None else {}
    if not isinstance(usage, dict):
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    prompt = int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0)
    completion = int(
        usage.get("completion_tokens") or usage.get("output_tokens") or 0
    )
    total = int(usage.get("total_tokens") or prompt + completion)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": total,
    }


def _error_message(value: Any) -> str | None:
    if not value:
        return None
    if isinstance(value, dict):
        return str(value.get("message") or value)
    return str(value)
