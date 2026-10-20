"""pytest 公共配置：把 scripts/ 与 tests/python/ 加入 sys.path。"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
for folder in (ROOT / "scripts", pathlib.Path(__file__).resolve().parent):
    if str(folder) not in sys.path:
        sys.path.insert(0, str(folder))
