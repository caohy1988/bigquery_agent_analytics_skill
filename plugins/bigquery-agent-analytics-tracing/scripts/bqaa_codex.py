#!/usr/bin/env python3
"""Entry script for the bqaa-codex wrapper.

Usage:
  bqaa_codex.py [PROMPT] [...codex exec args]

Replace ``codex exec`` with ``bqaa_codex.py`` and your Codex run will be
spooled to BigQuery Agent Analytics via the same async drainer the
Claude Code hook adapter uses. Codex's stdout text is forwarded to the
caller's stdout so the wrapper is transparent.
"""
from __future__ import annotations

import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_codex import main  # noqa: E402  (after sys.path tweak)


if __name__ == "__main__":
    raise SystemExit(main())
