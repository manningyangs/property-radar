# TASK-04B：internal 签名客户端——与服务端同口径（HMAC-SHA256(ts.nonce.body) 小写 hex）、
# 已知向量对拍、密钥缺失禁用、门禁错误映射、secret 不入异常。
from __future__ import annotations

import hashlib
import hmac

import httpx
import pytest

from property_radar_collectors import (
    InternalApiClient,
    InternalUnavailable,
    NotApprovedError,
)

BASE = "https://api.radar.test/api/v1"

# 已知向量（独立计算：HMAC-SHA256("vector-secret-04b", ts.nonce.body)）
VECTOR_SECRET = "vector-secret-04b"
VECTOR_TS = "1700000000"
VECTOR_NONCE = "nonce_abcdef123"
VECTOR_BODY = '{"a":1}'
VECTOR_HEX = "d6bb5d206b0e4a61aba7c3393dc9bdbc754802265c2f5d86f2001d873a149a1f"


def test_signature_known_vector() -> None:
    assert (
        InternalApiClient.sign(VECTOR_SECRET, VECTOR_TS, VECTOR_NONCE, VECTOR_BODY)
        == VECTOR_HEX
    )


def test_signature_matches_independent_hmac_and_covers_body() -> None:
    expected = hmac.new(
        VECTOR_SECRET.encode(), f"{VECTOR_TS}.{VECTOR_NONCE}.{VECTOR_BODY}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert InternalApiClient.sign(VECTOR_SECRET, VECTOR_TS, VECTOR_NONCE, VECTOR_BODY) == expected
    # body 篡改 → 签名不同（服务端据此拒绝）
    tampered = InternalApiClient.sign(
        VECTOR_SECRET, VECTOR_TS, VECTOR_NONCE, '{"a":2}'
    )
    assert tampered != expected
    # nonce/时间戳同样参与签名
    assert (
        InternalApiClient.sign(VECTOR_SECRET, VECTOR_TS, "other_nonce", VECTOR_BODY)
        != expected
    )


def test_missing_secret_disables_client() -> None:
    client = InternalApiClient(BASE, secret="")
    with pytest.raises(InternalUnavailable) as exc:
        client.check_eligibility("src_x")
    assert "INGEST_HMAC_SECRET" in str(exc.value)
    # 异常里绝不出现空串之外的秘密
    client.close()


def test_secret_from_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INGEST_HMAC_SECRET", "env-secret-04b")
    captured: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        captured["body"] = request.content.decode()
        return httpx.Response(200, json={"eligible": True, "status": "approved_open"})

    client = InternalApiClient(BASE, transport=httpx.MockTransport(handler))
    client.check_eligibility("src_x", "3301", "community")
    ts = captured["headers"]["x-ingest-timestamp"]
    nonce = captured["headers"]["x-ingest-nonce"]
    # 服务端口径复算：HMAC(secret, ts.nonce.rawBody)
    expected = hmac.new(
        b"env-secret-04b",
        f"{ts}.{nonce}.{captured['body']}".encode(),
        hashlib.sha256,
    ).hexdigest()
    assert captured["headers"]["x-ingest-signature"] == expected
    # nonce 高熵且符合服务端形态
    assert 8 <= len(nonce) <= 128
    client.close()


def test_server_gate_error_maps_to_not_approved() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403, json={"error_code": "source_not_approved", "message": "未批准"}
        )

    client = InternalApiClient(
        BASE, secret="s", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(NotApprovedError) as exc:
        client.submit_batch(
            {"batch_id": "b1", "source_id": "src", "city_code": "3301", "object_level": "community"}
        )
    assert exc.value.code == "not_approved"
    assert "未批准" in str(exc.value)
    client.close()


def test_generic_403_is_internal_unavailable_and_hides_secret() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403, json={"error_code": "signature_invalid", "message": "签名无效"}
        )

    client = InternalApiClient(
        BASE, secret="super-secret-should-not-leak", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(InternalUnavailable) as exc:
        client.job_start({"job_id": "j1", "source_id": "s", "city_code": "c", "object_level": "community"})
    text = str(exc.value)
    assert "signature_invalid" in text
    assert "super-secret-should-not-leak" not in text
    client.close()


def test_nonce_unique_per_request() -> None:
    nonces: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonces.append(request.headers["x-ingest-nonce"])
        return httpx.Response(202, json={"status": "accepted"})

    client = InternalApiClient(
        BASE, secret="s", transport=httpx.MockTransport(handler)
    )
    payload = {"batch_id": "b", "source_id": "s", "city_code": "c", "object_level": "community"}
    client.submit_batch(payload)
    client.submit_batch(payload)
    assert len(set(nonces)) == 2  # 防重放：每次请求随机 nonce
    client.close()


def test_transport_failure_maps_to_internal_unavailable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    client = InternalApiClient(
        BASE, secret="s", transport=httpx.MockTransport(handler)
    )
    with pytest.raises(InternalUnavailable):
        client.report_health({"source_id": "src", "status": "down"})
    client.close()
