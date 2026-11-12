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


# ---- TASK-04C：显式声明的明文 http 例外（青岛市统计局站点 http-only，核验报告 §1）----

HTTP_HOSTS = ("data.example.org", "open.example.org")
HTTP_OK = ("data.example.org",)  # 仅一个主机声明 http 例外


def test_declared_http_exception_passes() -> None:
    parts = assert_url_allowed(
        "http://data.example.org/list.shtml", HTTP_HOSTS, allow_http_hosts=HTTP_OK
    )
    assert parts.scheme == "http"
    assert parts.hostname == "data.example.org"


def test_http_on_whitelisted_host_without_exception_rejected() -> None:
    # 在白名单内但未声明 http 例外 → 仍拒绝（http 例外必须逐主机显式声明）
    with pytest.raises(AllowlistViolation) as exc:
        assert_url_allowed(
            "http://open.example.org/x", HTTP_HOSTS, allow_http_hosts=HTTP_OK
        )
    assert exc.value.code == "allowlist_violation"


def test_http_exception_outside_allowlist_rejected() -> None:
    # http 例外清单必须是白名单子集（配置一致性双保险）
    with pytest.raises(AllowlistViolation):
        assert_url_allowed(
            "http://evil.example.com/",
            ("data.example.org",),
            allow_http_hosts=("evil.example.com",),
        )


def test_http_non_default_port_rejected() -> None:
    with pytest.raises(AllowlistViolation):
        assert_url_allowed(
            "http://data.example.org:8080/x",
            HTTP_HOSTS,
            allow_http_hosts=HTTP_OK,
        )


def test_http_still_requires_host_match() -> None:
    # 例外只放开 scheme，不放开主机校验
    with pytest.raises(AllowlistViolation):
        assert_url_allowed(
            "http://evil.example.com/x", HTTP_HOSTS, allow_http_hosts=HTTP_OK
        )


def test_undeclared_http_still_rejected_in_network_guard() -> None:
    """未声明 http 例外时，http URL 在网络 I/O 前被拒（零请求）。"""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text="ok")

    client = SafeHttpClient(
        ALLOWED,
        SafeHttpConfig(min_request_interval=0.0),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(AllowlistViolation):
        client.get_text("http://data.example.org/list.shtml")
    assert seen == []
    client.close()


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
