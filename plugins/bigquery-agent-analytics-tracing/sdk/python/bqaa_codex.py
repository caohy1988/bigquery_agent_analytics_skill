"""BQAA tracing wrapper for OpenAI Codex CLI.

Codex CLI (>= 0.128) doesn't ship a hook system like Claude Code, but
``codex exec --json`` emits a JSONL event stream over stdout. This module
provides a transparent wrapper that:

  1. Spawns ``codex exec --json [args]`` as a subprocess.
  2. Streams the JSONL event stream and maps each event to the BQAA
     schema via the shared ``BigQueryAgentAnalyticsLogger`` (so it
     re-uses the spool + async drainer + Storage Write API path that
     the Claude Code hook adapter uses).
  3. Forwards Codex's agent text to stdout so the user's UX is
     identical to invoking ``codex exec`` directly.
  4. Exits with Codex's exit code.

Event mapping:

  ``thread.started``                         -> capture session_id
  ``turn.started``                           -> emit LLM_REQUEST
  ``item.started`` (non-message)             -> emit TOOL_STARTING
  ``item.completed`` (non-message)           -> emit TOOL_COMPLETED
  ``item.completed`` (agent_message)         -> accumulate text + echo
  ``turn.completed``                         -> emit LLM_RESPONSE w/ usage

The wrapper sets ``attributes.source = "codex_cli"`` and stamps
``writer.agent = "codex-cli"`` so adoption queries can attribute traffic
back to Codex without ambiguity (see Finding #2 of PR #2 review: the
SDK methods no longer hard-code claude_code).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from typing import Any

from bqaa_tracing import (
    BQAAConfig,
    BigQueryAgentAnalyticsLogger,
    _deterministic_span,
    _hex_id,
    _to_jsonable,
)

DEFAULT_AGENT_NAME = "codex-cli"
SOURCE = "codex_cli"
TOOL_NAME_MAP = {
    "command_execution": "shell",
    "file_change": "file_change",
    "patch_apply": "patch_apply",
    "mcp_tool_call": "mcp_tool",
    "web_search": "web_search",
}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _resolve_agent_name(config: BQAAConfig) -> str:
    """Use BQAA_AGENT_NAME if user set it, otherwise default to codex-cli.

    The default in BQAAConfig.from_env is ``coding-agent`` (a generic
    fallback) — when the wrapper boots it should default to ``codex-cli``
    rather than the generic name unless the user explicitly overrode it.
    """
    if not config.agent_name or config.agent_name == "coding-agent":
        return DEFAULT_AGENT_NAME
    return config.agent_name


def _extract_prompt(argv: list[str]) -> str:
    """Best-effort prompt capture from the wrapper's argv.

    Codex itself accepts the prompt as a trailing positional, with options
    interspersed via ``-c key=value``, ``--config``, ``--model``, etc. For
    BQAA's purposes we only need it for the LLM_REQUEST content, so we
    walk argv right-to-left and pick the first non-flag, non-``-`` token.

    If no prompt is in argv (e.g. user piped via stdin and passed ``-``),
    we honor the BQAA_CODEX_PROMPT env override; otherwise an empty
    string lands in LLM_REQUEST and the row still flows through.
    """
    for token in reversed(argv):
        if not token:
            continue
        if token == "-" or token.startswith("-"):
            continue
        return token
    return os.environ.get("BQAA_CODEX_PROMPT", "")


def _attributes(extra: dict[str, Any] | None = None) -> dict[str, Any]:
    base: dict[str, Any] = {
        "source": SOURCE,
        "session_metadata": {"source": SOURCE},
        "custom_tags": {"assistant": DEFAULT_AGENT_NAME},
    }
    if extra:
        base.update(extra)
    return base


def _tool_name_for(item_type: str) -> str:
    return TOOL_NAME_MAP.get(item_type, item_type or "unknown")


def _tool_origin_for(item_type: str) -> str:
    if item_type == "mcp_tool_call":
        return "MCP"
    return "LOCAL"


def _normalize_usage(usage: dict[str, Any]) -> dict[str, int]:
    """Map Codex's usage keys to BQAA's prompt/completion/total shape."""
    if not isinstance(usage, dict):
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    # Codex's input_tokens already reflects total billed input including
    # cached prefix for the turn. Treat cached_input_tokens as a sub-bucket
    # we surface in attributes, not added on top of input_tokens.
    prompt = int(usage.get("input_tokens") or 0)
    completion = int(usage.get("output_tokens") or 0)
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    }


def _usage_extras(usage: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(usage, dict):
        return {}
    extras: dict[str, Any] = {}
    cached = usage.get("cached_input_tokens")
    if cached is not None:
        extras["cached_input_tokens"] = int(cached)
    reasoning = usage.get("reasoning_output_tokens")
    if reasoning is not None:
        extras["reasoning_output_tokens"] = int(reasoning)
    return extras


class CodexBQAAWrapper:
    """Drives a single ``codex exec --json`` subprocess and emits BQAA rows."""

    def __init__(
        self,
        codex_argv: list[str],
        *,
        config: BQAAConfig | None = None,
        codex_bin: str | None = None,
        prompt: str | None = None,
        stdout: Any = None,
        stderr: Any = None,
    ):
        self.codex_argv = codex_argv
        self.codex_bin = codex_bin or os.environ.get("BQAA_CODEX_BIN") or "codex"
        self.prompt = prompt if prompt is not None else _extract_prompt(codex_argv)
        self.config = config or BQAAConfig.from_env()
        self.agent = _resolve_agent_name(self.config)
        self.logger = BigQueryAgentAnalyticsLogger(self.config)
        self._stdout = stdout if stdout is not None else sys.stdout
        self._stderr = stderr if stderr is not None else sys.stderr

        # Per-process state. Codex emits one or more turn cycles per
        # invocation (interactive resume / forks). We reset turn state on
        # each turn.started so multi-turn invocations stay clean.
        self.session_id: str | None = None
        self.turn_invocation_id: str | None = None
        self.turn_trace_id: str | None = None
        self.turn_llm_span: str | None = None
        self.turn_start_ms: int | None = None
        self.turn_text: list[str] = []
        self.pending_tools: dict[str, dict[str, Any]] = {}

    # ---- entrypoint ------------------------------------------------------

    def run(self) -> int:
        argv = [self.codex_bin, "exec", "--json", *self.codex_argv]
        try:
            proc = subprocess.Popen(
                argv,
                stdout=subprocess.PIPE,
                stderr=self._stderr,
                bufsize=1,  # line-buffered so we see events as Codex emits them
                text=True,
            )
        except FileNotFoundError as exc:
            print(f"bqaa-codex: cannot launch codex ({exc})", file=self._stderr)
            return 127

        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                self._handle_line(line)
        except KeyboardInterrupt:
            proc.terminate()
            proc.wait()
            return 130
        return proc.wait()

    # ---- per-line dispatch ----------------------------------------------

    def _handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # Non-JSON output should never happen on --json mode, but if
            # Codex injects status text we just forward it.
            print(line, file=self._stderr)
            return
        ev_type = event.get("type")
        if ev_type == "thread.started":
            self._on_thread_started(event)
        elif ev_type == "turn.started":
            self._on_turn_started(event)
        elif ev_type == "item.started":
            self._on_item_started(event)
        elif ev_type == "item.completed":
            self._on_item_completed(event)
        elif ev_type == "turn.completed":
            self._on_turn_completed(event)
        # Unknown event types are ignored; future Codex versions can add
        # event types and this wrapper still works.

    # ---- handlers --------------------------------------------------------

    def _on_thread_started(self, event: dict[str, Any]) -> None:
        thread_id = event.get("thread_id")
        self.session_id = str(thread_id) if thread_id else _hex_id(32)

    def _on_turn_started(self, _event: dict[str, Any]) -> None:
        self.turn_invocation_id = _hex_id(32)
        self.turn_trace_id = _hex_id(32)
        self.turn_llm_span = _hex_id(16)
        self.turn_start_ms = _now_ms()
        self.turn_text = []
        self.pending_tools.clear()
        session_id = self.session_id or _hex_id(32)
        self.logger.log_llm_request(
            prompt=self.prompt or "",
            session_id=session_id,
            invocation_id=self.turn_invocation_id,
            trace_id=self.turn_trace_id,
            span_id=self.turn_llm_span,
            agent=self.agent,
            user_id=self.config.user_id,
            attributes=_attributes(),
        )

    def _on_item_started(self, event: dict[str, Any]) -> None:
        item = event.get("item") or {}
        item_id = str(item.get("id") or _hex_id(8))
        item_type = str(item.get("type") or "unknown")
        if item_type == "agent_message":
            return  # Final-text items are handled in item.completed.

        # Deterministic span keyed on session+item id so a missing
        # item.started (rare) still correlates with item.completed.
        seed = f"{self.session_id or 'codex'}/{item_id}"
        span_id = _deterministic_span(seed)
        self.pending_tools[item_id] = {
            "span_id": span_id,
            "start_ms": _now_ms(),
            "tool": _tool_name_for(item_type),
            "item_type": item_type,
        }
        args = self._tool_args_from_item(item, item_type)
        self.logger.log_tool_starting(
            tool=_tool_name_for(item_type),
            args=_to_jsonable(args),
            session_id=self.session_id or _hex_id(32),
            invocation_id=self.turn_invocation_id or _hex_id(32),
            trace_id=self.turn_trace_id or _hex_id(32),
            span_id=span_id,
            parent_span_id=self.turn_llm_span,
            agent=self.agent,
            tool_origin=_tool_origin_for(item_type),
            attributes=_attributes({"codex_item_type": item_type}),
        )

    def _on_item_completed(self, event: dict[str, Any]) -> None:
        item = event.get("item") or {}
        item_id = str(item.get("id") or "")
        item_type = str(item.get("type") or "unknown")

        if item_type == "agent_message":
            text = str(item.get("text") or "")
            if text:
                self.turn_text.append(text)
                # Forward the agent's text to the user so the wrapper
                # is a transparent stand-in for `codex exec`.
                print(text, file=self._stdout, flush=True)
            return

        started = self.pending_tools.pop(item_id, {})
        seed = f"{self.session_id or 'codex'}/{item_id}"
        span_id = started.get("span_id") or _deterministic_span(seed)
        start_ms = int(started.get("start_ms") or _now_ms())
        result = self._tool_result_from_item(item, item_type)
        status, error_message = self._status_from_item(item, item_type)
        self.logger.log_tool_completed(
            tool=_tool_name_for(item_type),
            result=_to_jsonable(result),
            session_id=self.session_id or _hex_id(32),
            invocation_id=self.turn_invocation_id or _hex_id(32),
            trace_id=self.turn_trace_id or _hex_id(32),
            span_id=span_id,
            parent_span_id=self.turn_llm_span,
            agent=self.agent,
            tool_origin=_tool_origin_for(item_type),
            total_ms=max(0, _now_ms() - start_ms),
            status=status,
            error_message=error_message,
            attributes=_attributes({"codex_item_type": item_type}),
        )

    def _on_turn_completed(self, event: dict[str, Any]) -> None:
        usage = event.get("usage") or {}
        usage_metadata = _normalize_usage(usage)
        extras = _usage_extras(usage)
        attrs = _attributes()
        if extras:
            attrs["usage_extras"] = extras
        total_ms = max(0, _now_ms() - int(self.turn_start_ms or _now_ms()))
        response_text = "\n".join(self.turn_text).strip() or "(No response captured)"
        self.logger.log_llm_response(
            response=response_text,
            session_id=self.session_id or _hex_id(32),
            invocation_id=self.turn_invocation_id or _hex_id(32),
            trace_id=self.turn_trace_id or _hex_id(32),
            span_id=self.turn_llm_span or _hex_id(16),
            agent=self.agent,
            user_id=self.config.user_id,
            usage_metadata=usage_metadata,
            total_ms=total_ms,
            attributes=attrs,
        )

    # ---- payload extraction ---------------------------------------------

    @staticmethod
    def _tool_args_from_item(item: dict[str, Any], item_type: str) -> dict[str, Any]:
        if item_type == "command_execution":
            return {"command": item.get("command")}
        # For unknown item types pass through everything except heavy
        # output fields so the args column stays compact.
        return {
            k: v
            for k, v in item.items()
            if k not in ("id", "status", "aggregated_output", "exit_code")
        }

    @staticmethod
    def _tool_result_from_item(
        item: dict[str, Any], item_type: str
    ) -> dict[str, Any]:
        if item_type == "command_execution":
            return {
                "exit_code": item.get("exit_code"),
                "status": item.get("status"),
                "output": item.get("aggregated_output"),
            }
        return {
            k: v for k, v in item.items() if k not in ("id", "type", "command")
        }

    @staticmethod
    def _status_from_item(
        item: dict[str, Any], item_type: str
    ) -> tuple[str, str | None]:
        if item_type == "command_execution":
            exit_code = item.get("exit_code")
            if exit_code in (0, None):
                return "OK", None
            return "ERROR", f"exit_code={exit_code}"
        # Generic: trust item.status if present.
        status = str(item.get("status") or "completed")
        if status.lower() in ("failed", "error", "errored"):
            return "ERROR", str(item.get("error") or status)
        return "OK", None


def main(argv: list[str] | None = None) -> int:
    """Entry point used by the wrapper CLI.

    All argv after the wrapper itself is forwarded to ``codex exec``,
    along with an injected ``--json`` flag.
    """
    argv = argv if argv is not None else sys.argv[1:]
    try:
        wrapper = CodexBQAAWrapper(argv)
    except Exception as exc:
        print(f"bqaa-codex: setup failed: {exc}", file=sys.stderr)
        return 2
    return wrapper.run()


if __name__ == "__main__":
    raise SystemExit(main())
