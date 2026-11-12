# TASK-04B：安全 HTTP 层——超时/重试/4xx/5xx/响应上限/速率限制/日志脱敏（全部不出网）
from __future__ import annotations

import logging
import time

import httpx
import pytest

from property_radar_collectors import (
    HttpStatusError,
    ParseError,
    ResponseTooLarge,
    RetriesExhausted,
    SafeHttpClient,
    SafeHttpConfig,
    TimeoutExceeded,
    redact,
)

ALLOWED = ("data.example.org",)
URL = "https://data.example.org/api/prices"


def make_client(handler, **cfg) -> tuple[SafeHttpClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def tracking(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    cfg.setdefault("min_request_interval", 0.0)
    cfg.setdefault("backoff_base_seconds", 0.01)
    config = SafeHttpConfig(**cfg)
    client = SafeHttpClient(
        ALLOWED, config, transport=httpx.MockTransport(tracking)
    )
    return client, seen


def test_get_json_success() -> None:
    client, seen = make_client(lambda r: httpx.Response(200, json={"median": 40000}))
    assert client.get_json(URL) == {"median": 40000}
    assert len(seen) == 1
    assert seen[0].method == "GET"
    client.close()


def test_4xx_no_retry() -> None:
    calls = 0

    def handler(r):
        nonlocal calls
        calls += 1
        return httpx.Response(404, text="secret-page-content")

    client, _ = make_client(handler)
    with pytest.raises(HttpStatusError) as exc:
        client.get_json(URL)
    assert exc.value.status == 404
    assert exc.value.code == "http_status_error"
    # 不回显响应体
    assert "secret-page-content" not in str(exc.value)
    assert calls == 1  # 4xx 不重试
    client.close()


def test_5xx_retries_then_success() -> None:
    calls = 0

    def handler(r):
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(503, text="boom")
        return httpx.Response(200, json={"ok": 1})

    client, _ = make_client(handler, max_retries=2)
    assert client.get_json(URL) == {"ok": 1}
    assert calls == 2
    client.close()


def test_5xx_retries_exhausted() -> None:
    client, seen = make_client(
        lambda r: httpx.Response(500, text="err"), max_retries=1
    )
    with pytest.raises(RetriesExhausted) as exc:
        client.get_json(URL)
    assert exc.value.code == "retries_exhausted"
    assert len(seen) == 2  # 1 次原始 + 1 次重试
    client.close()


def test_timeout_exceeded() -> None:
    def handler(r):
        raise httpx.ConnectTimeout("timed out", request=r)

    client, seen = make_client(handler, max_retries=1)
    with pytest.raises(TimeoutExceeded) as exc:
        client.get_json(URL)
    assert exc.value.code == "timeout_exceeded"
    assert len(seen) == 2
    client.close()


def test_response_too_large_aborts_read() -> None:
    payload = "x" * 500
    client, _ = make_client(
        lambda r: httpx.Response(200, text=payload), max_response_bytes=100
    )
    with pytest.raises(ResponseTooLarge) as exc:
        client.get_json(URL)
    assert exc.value.code == "response_too_large"
    client.close()


def test_redirect_not_followed() -> None:
    """3xx 不跟随——防跳转绕过白名单。"""
    client, seen = make_client(
        lambda r: httpx.Response(302, headers={"location": "https://evil.example.com/"})
    )
    with pytest.raises(HttpStatusError) as exc:
        client.get_json(URL)
    assert exc.value.status == 302
    assert len(seen) == 1
    client.close()


def test_invalid_json_parse_error() -> None:
    client, _ = make_client(lambda r: httpx.Response(200, text="<html>not json</html>"))
    with pytest.raises(ParseError) as exc:
        client.get_json(URL)
    assert exc.value.code == "parse_error"
    client.close()


def test_rate_limit_enforced_between_requests() -> None:
    client, _ = make_client(
        lambda r: httpx.Response(200, json={}), min_request_interval=0.1
    )
    started = time.monotonic()
    client.get_json(URL)
    client.get_json(URL)
    elapsed = time.monotonic() - started
    assert elapsed >= 0.09  # 两次请求间至少间隔 min_request_interval
    client.close()


def test_log_never_contains_headers_or_secrets(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """500 失败时日志不含 Authorization 头值与任何 secret。"""
    client, _ = make_client(lambda r: httpx.Response(500, text="err"), max_retries=0)
    with caplog.at_level(logging.INFO, logger="property_radar_collectors.http"):
        with pytest.raises(RetriesExhausted):
            client.get_json(
                URL, headers={"Authorization": "Bearer secret-token-abc123"}
            )
    text = caplog.text
    assert "secret-token-abc123" not in text
    assert "Authorization" not in text
    assert "secret-token-abc123" not in " ".join(
        r.getMessage() for r in caplog.records
    )
    client.close()


def test_redact_masks_credentials_and_tokens() -> None:
    assert "zhang.san@" not in redact("contact zhang.san@example.com now")
    assert redact("token: abc123def456ghi789jkl012mno") .count("***") >= 1
    assert "Bearer xyz" not in redact("header Bearer abc.def.ghi")
    assert (
        redact("INGEST_HMAC_SECRET=super-secret-value-04b")
        != "INGEST_HMAC_SECRET=super-secret-value-04b"
    )
