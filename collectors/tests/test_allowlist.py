# TASK-04B 验收一：不存在 arbitrary URL fetch——白名单校验发生在一切网络 I/O 之前
from __future__ import annotations

import httpx
import pytest

from property_radar_collectors import (
    AllowlistViolation,
    SafeHttpClient,
    SafeHttpConfig,
    assert_url_allowed,
)

ALLOWED = ("data.example.org",)


def test_allowed_https_url_passes() -> None:
    parts = assert_url_allowed("https://data.example.org/api/prices?x=1", ALLOWED)
    assert parts.hostname == "data.example.org"


@pytest.mark.parametrize(
    "url",
    [
        "https://evil.example.com/price",           # 白名单外
        "http://data.example.org/price",            # 非 https
        "https://user:pass@data.example.org/x",     # 内嵌凭据
        "https://data.example.org:8443/price",      # 非默认端口
        "https://notdata.example.org.evil/x",       # 后缀伪装
        "https://data.example.org.evil.com/x",      # 前缀伪装
    ],
)
def test_violations_rejected(url: str) -> None:
    with pytest.raises(AllowlistViolation) as exc:
        assert_url_allowed(url, ALLOWED)
    assert exc.value.code == "allowlist_violation"


def test_empty_allowlist_fails_closed() -> None:
    with pytest.raises(AllowlistViolation):
        assert_url_allowed("https://anything.example.com/", ())


def test_violation_makes_zero_network_calls() -> None:
    """违规 URL 在网络 I/O 之前被拒——MockTransport 收到的请求必须为 0。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"ok": True})

    client = SafeHttpClient(
        ALLOWED,
        SafeHttpConfig(min_request_interval=0.0),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(AllowlistViolation):
        client.get_json("https://evil.example.com/price")
    with pytest.raises(AllowlistViolation):
        client.get_json("http://data.example.org/price")
    assert seen == []
    client.close()
