# TASK-04B 验收二：不能设置 approved 的连接器无法运行——
# run_guard 先经 /internal/sources/:id/eligibility 走服务端 source-gate，
# 拒绝（403/404）时零采集请求、未提交批次。
from __future__ import annotations

import httpx
import pytest

from property_radar_collectors import (
    InternalApiClient,
    NotApprovedError,
    run_guard,
)

BASE = "https://api.radar.test/api/v1"
ELIGIBILITY_PATH = f"/api/v1/internal/sources/src_gate/eligibility"


def make_client(handler) -> tuple[InternalApiClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def tracking(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = InternalApiClient(
        BASE, secret="gate-secret", transport=httpx.MockTransport(tracking)
    )
    return client, seen


def eligibility_response(status: int, body: dict) -> httpx.Response:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == ELIGIBILITY_PATH, "run_guard 只允许调用资格端点"
        return httpx.Response(status, json=body)

    return handler  # type: ignore[return-value]


def test_not_approved_aborts_before_any_collection_request() -> None:
    client, seen = make_client(
        eligibility_response(
            403, {"error_code": "source_not_approved", "message": "来源未批准"}
        )
    )
    with pytest.raises(NotApprovedError) as exc:
        run_guard(client, "src_gate", "3301", "community")
    assert exc.value.code == "not_approved"
    # 唯一的出站请求就是资格预检——没有任何采集/批次请求
    assert len(seen) == 1
    assert seen[0].url.path == ELIGIBILITY_PATH
    client.close()


def test_unknown_source_404_also_blocks() -> None:
    client, seen = make_client(
        eligibility_response(404, {"error_code": "source_not_found", "message": "不存在"})
    )
    with pytest.raises(NotApprovedError):
        run_guard(client, "src_gate", "3301", "community")
    assert len(seen) == 1
    client.close()


def test_coverage_denied_blocks() -> None:
    client, seen = make_client(
        eligibility_response(
            403, {"error_code": "city_coverage_denied", "message": "超范围"}
        )
    )
    with pytest.raises(NotApprovedError):
        run_guard(client, "src_gate", "9999", "listing")
    client.close()


def test_eligible_true_passes() -> None:
    body = {
        "eligible": True,
        "source_id": "src_gate",
        "status": "approved_open",
        "valid_until": None,
    }
    client, seen = make_client(eligibility_response(200, body))
    result = run_guard(client, "src_gate", "3301", "community")
    assert result["eligible"] is True
    assert result["status"] == "approved_open"
    # 预检请求带 coverage 且签名存在
    assert len(seen) == 1
    assert "X-Ingest-Signature" in seen[0].headers
    client.close()


def test_eligible_false_defensive_blocks() -> None:
    client, _ = make_client(
        eligibility_response(
            200, {"eligible": False, "source_id": "src_gate", "status": "suspended"}
        )
    )
    with pytest.raises(NotApprovedError):
        run_guard(client, "src_gate", "3301", "community")
    client.close()
