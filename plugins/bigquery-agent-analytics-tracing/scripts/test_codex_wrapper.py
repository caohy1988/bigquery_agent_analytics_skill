#!/usr/bin/env python3
from __future__ import annotations

import io
import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_codex import CodexBQAAWrapper
from bqaa_codex import _combine_prompt
from bqaa_codex import _extract_prompt


def test_prompt_parser() -> None:
    cases = [
        (["hello"], "hello"),
        (["--output-last-message", "out.txt", "my prompt"], "my prompt"),
        (["-o", "out.txt", "my prompt"], "my prompt"),
        (["--model", "gpt-5", "say ok"], "say ok"),
        (["--model=gpt-5", "say ok"], "say ok"),
        (["--", "--not-a-flag prompt"], "--not-a-flag prompt"),
        (["--sandbox", "read-only", "-"], ""),
        (["-c", "model=\"x\"", "prompt"], "prompt"),
        (["--image", "a.png", "prompt"], "prompt"),
        (["--add-dir", "/tmp", "prompt"], "prompt"),
        (["--output-schema", "schema.json", "prompt"], "prompt"),
    ]
    for argv, expected in cases:
        actual = _extract_prompt(argv)
        assert actual == expected, f"{argv}: got {actual!r}, expected {expected!r}"


def test_prompt_composition() -> None:
    assert _combine_prompt("respond ok", "EXTRA") == "respond ok\n<stdin>\nEXTRA\n</stdin>"
    assert _combine_prompt("", "EXTRA") == "EXTRA"
    assert _combine_prompt("respond ok", "") == "respond ok"


def test_stdin_capture() -> None:
    wrapper = CodexBQAAWrapper(
        [],
        stdin=io.StringIO("stdin payload"),
        codex_bin="missing-codex-for-version",
    )
    captured, child_stdin = wrapper._read_stdin_payload()
    assert captured == "stdin payload"
    assert child_stdin is not None
    assert child_stdin.read() == "stdin payload"
    child_stdin.close()


def test_stdin_capture_is_capped_but_child_stdin_is_full() -> None:
    wrapper = CodexBQAAWrapper(
        [],
        stdin=io.StringIO("abcdef"),
        codex_bin="missing-codex-for-version",
    )
    wrapper.STDIN_READ_LIMIT = 3
    captured, child_stdin = wrapper._read_stdin_payload()
    assert captured == "abc\n...[STDIN_TRUNCATED]"
    assert child_stdin is not None
    assert child_stdin.read() == "abcdef"
    child_stdin.close()


def main() -> int:
    test_prompt_parser()
    test_prompt_composition()
    test_stdin_capture()
    test_stdin_capture_is_capped_but_child_stdin_is_full()
    print("codex wrapper tests passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
