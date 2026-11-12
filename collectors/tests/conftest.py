# 共享 fixture 加载（pytest.ini pythonpath=. 已把 collectors/ 加入 sys.path）
from __future__ import annotations

import json
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / "fixtures"


@pytest.fixture
def load_fixture():
    """按文件名加载 tests/fixtures/*.json。"""

    def _load(name: str) -> dict:
        return json.loads((FIXTURES_DIR / name).read_text(encoding="utf-8"))

    return _load
