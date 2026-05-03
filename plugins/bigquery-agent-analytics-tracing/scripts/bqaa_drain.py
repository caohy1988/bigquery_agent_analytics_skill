#!/usr/bin/env python3
from __future__ import annotations

import sys
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[1]
SDK_PATH = PLUGIN_ROOT / "sdk" / "python"
sys.path.insert(0, str(SDK_PATH))

from bqaa_drain import main


if __name__ == "__main__":
    raise SystemExit(main())
