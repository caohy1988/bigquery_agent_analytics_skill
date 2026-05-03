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
import tempfile
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

# Codex `exec` flags that consume the next argv token. Drawn from
# `codex exec --help` (codex-cli 0.128). Boolean flags and the
# combined ``--flag=value`` form do not need to appear here. The
# parser walks argv left-to-right and skips one token after each of
# these flags so the remaining positionals are the real prompt
# candidates — fixes the prior best-effort right-to-left walk that
# could pick up flag values like ``--output-last-message out.txt``.
CODEX_VALUE_FLAGS: frozenset[str] = frozenset(
    {
        "-c",
        "--config",
        "--enable",
        "--disable",
        "-i",
        "--image",
        "-m",
        "--model",
        "--local-provider",
        "-p",
        "--profile",
        "-s",
        "--sandbox",
        "-C",
        "--cd",
        "--add-dir",
        "--output-schema",
        "--color",
        "-o",
        "--output-last-message",
    }
)


def _now_ms() -> int:
    return int(time.time() * 1000)


def _codex_version(codex_bin: str) -> str | None:
    """Return ``codex --version`` output (best effort, capped, cached-per-init)."""
    try:
        result = subprocess.run(
            [codex_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return None
    text = (result.stdout or result.stderr or "").strip()
    return text[:128] if text else None


def _combine_prompt(argv_prompt: str, stdin_payload: str) -> str:
    """Mirror Codex's prompt composition for BQAA's LLM_REQUEST.

    Codex docs: "If stdin is piped and a prompt is also provided, stdin
    is appended as a `<stdin>` block." We mirror that so the captured
    LLM_REQUEST content matches what Codex actually sees.
    """
    if argv_prompt and stdin_payload:
        return f"{argv_prompt}\n<stdin>\n{stdin_payload}\n</stdin>"
    return stdin_payload or argv_prompt


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
    """Pull the trailing positional out of argv, skipping known flag values.

    Walks argv left-to-right (not right-to-left) and consumes a value
    token after every known value-flag in ``CODEX_VALUE_FLAGS``. Combined
    ``--flag=value`` is treated as a single token. Anything after ``--``
    is positional. The trailing positional is the prompt; falls back to
    the ``BQAA_CODEX_PROMPT`` env override if no positional is found.

    Note: stdin-supplied prompts are picked up by the wrapper separately
    (see ``CodexBQAAWrapper._read_stdin_payload``); this function only
    sees argv.
    """
    positionals: list[str] = []
    i = 0
    n = len(argv)
    while i < n:
        token = argv[i]
        if token == "--":
            positionals.extend(t for t in argv[i + 1 :] if t and t != "-")
            break
        if token.startswith("-") and token != "-":
            if "=" in token:
                # --flag=value form: value is bundled in this token.
                i += 1
                continue
            if token in CODEX_VALUE_FLAGS and i + 1 < n:
                # Skip the value that follows.
                i += 2
                continue
            # Unknown long flag or known boolean flag — single token.
            i += 1
            continue
        if token and token != "-":
            positionals.append(token)
        i += 1
    if positionals:
        return positionals[-1]
    return os.environ.get("BQAA_CODEX_PROMPT", "")


def _attributes(
    *,
    codex_version: str | None,
    raw_event_type: str | None = None,
    raw_item_type: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the attributes block for a row.

    Always includes a ``codex`` block with at least the Codex CLI
    version (captured via ``codex --version`` at wrapper init). When
    relevant, also stamps the raw Codex event type and item type so
    that future schema drift in the JSONL stream is debuggable from
    the events table itself, without needing to re-derive from logs.
    """
    codex_block: dict[str, Any] = {}
    if codex_version:
        codex_block["version"] = codex_version
    if raw_event_type:
        codex_block["raw_event_type"] = raw_event_type
    if raw_item_type:
        codex_block["raw_item_type"] = raw_item_type
    base: dict[str, Any] = {
        "source": SOURCE,
        "session_metadata": {"source": SOURCE},
        "custom_tags": {"assistant": DEFAULT_AGENT_NAME},
    }
    if codex_block:
        base["codex"] = codex_block
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

    STDIN_READ_LIMIT = 1 * 1024 * 1024  # 1 MiB cap on the captured stdin payload.

    def __init__(
        self,
        codex_argv: list[str],
        *,
        config: BQAAConfig | None = None,
        codex_bin: str | None = None,
        prompt: str | None = None,
        stdin: Any = None,
        stdout: Any = None,
        stderr: Any = None,
    ):
        self.codex_argv = codex_argv
        self.codex_bin = codex_bin or os.environ.get("BQAA_CODEX_BIN") or "codex"
        self.argv_prompt = prompt if prompt is not None else _extract_prompt(codex_argv)
        self.config = config or BQAAConfig.from_env()
        self.agent = _resolve_agent_name(self.config)
        self.logger = BigQueryAgentAnalyticsLogger(self.config)
        self._stdin = stdin if stdin is not None else sys.stdin
        self._stdout = stdout if stdout is not None else sys.stdout
        self._stderr = stderr if stderr is not None else sys.stderr
        self.codex_version = _codex_version(self.codex_bin)
        # Captured at run() time once we know whether stdin is piped. This is
        # capped for BQAA row size, but the child Codex process still receives
        # the full stdin stream via a temp file.
        self.stdin_payload: str = ""
        self.prompt: str = self.argv_prompt

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
        # Capture piped stdin (if any) so the BQAA LLM_REQUEST records
        # the real prompt bytes the model saw, not just the argv-derived
        # prompt. Codex itself reads stdin as part of its prompt when
        # `-` is the trailing positional or when it's piped without one.
        self.stdin_payload, child_stdin = self._read_stdin_payload()
        self.prompt = _combine_prompt(self.argv_prompt, self.stdin_payload)

        # Decide stdin handling for the Codex child. If stdin was piped, pass
        # a temp file containing the full payload; otherwise inherit the
        # wrapper's stdin (TTY or unread fd).
        argv = [self.codex_bin, "exec", "--json", *self.codex_argv]
        try:
            proc = subprocess.Popen(
                argv,
                stdin=child_stdin if child_stdin is not None else self._stdin,
                stdout=subprocess.PIPE,
                stderr=self._stderr,
                bufsize=1,  # line-buffered so we see events as Codex emits them
                text=True,
            )
        except FileNotFoundError as exc:
            print(f"bqaa-codex: cannot launch codex ({exc})", file=self._stderr)
            if child_stdin is not None:
                child_stdin.close()
            return 127

        try:
            assert proc.stdout is not None
            for line in proc.stdout:
                self._handle_line(line)
        except KeyboardInterrupt:
            proc.terminate()
            proc.wait()
            if child_stdin is not None:
                child_stdin.close()
            return 130
        result = proc.wait()
        if child_stdin is not None:
            child_stdin.close()
        return result

    def _read_stdin_payload(self) -> tuple[str, Any | None]:
        """Return (captured_prompt, full_child_stdin_file).

        The BQAA prompt capture is capped at STDIN_READ_LIMIT, but the full
        stdin payload is written to a temp file and passed to Codex unchanged.
        """
        stream = self._stdin
        try:
            isatty = stream.isatty()
        except (AttributeError, ValueError):
            isatty = True
        if isatty:
            return "", None

        captured_parts: list[str] = []
        captured_len = 0
        truncated = False
        wrote_any = False
        child_stdin = tempfile.TemporaryFile(mode="w+t", encoding="utf-8")
        try:
            while True:
                chunk = stream.read(64 * 1024)
                if not chunk:
                    break
                if isinstance(chunk, bytes):
                    chunk = chunk.decode("utf-8", "replace")
                wrote_any = True
                child_stdin.write(chunk)

                if captured_len < self.STDIN_READ_LIMIT:
                    remaining = self.STDIN_READ_LIMIT - captured_len
                    if len(chunk) > remaining:
                        captured_parts.append(chunk[:remaining])
                        captured_len = self.STDIN_READ_LIMIT
                        truncated = True
                    else:
                        captured_parts.append(chunk)
                        captured_len += len(chunk)
                else:
                    truncated = True
        except (OSError, ValueError):
            child_stdin.close()
            return "", None

        if not wrote_any:
            child_stdin.close()
            return "", None
        if truncated:
            captured_parts.append("\n...[STDIN_TRUNCATED]")
        child_stdin.seek(0)
        return "".join(captured_parts), child_stdin

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
            attributes=_attributes(
                codex_version=self.codex_version,
                raw_event_type="turn.started",
            ),
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
            attributes=_attributes(
                codex_version=self.codex_version,
                raw_event_type="item.started",
                raw_item_type=item_type,
            ),
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
            attributes=_attributes(
                codex_version=self.codex_version,
                raw_event_type="item.completed",
                raw_item_type=item_type,
            ),
        )

    def _on_turn_completed(self, event: dict[str, Any]) -> None:
        usage = event.get("usage") or {}
        usage_metadata = _normalize_usage(usage)
        extras = _usage_extras(usage)
        attrs = _attributes(
            codex_version=self.codex_version,
            raw_event_type="turn.completed",
        )
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
