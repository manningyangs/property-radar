# TASK-04B：SourceConnector 契约——四方法、community 未授权返回 unsupported、
# health_check 只访问白名单端点（全部经 MockTransport，不出网）
from __future__ import annotations

import httpx
import pytest

from property_radar_collectors import (
    UNSUPPORTED,
    SafeHttpClient,
    SafeHttpConfig,
    SourceConnector,
    SourceHealth,
    SourceRecord,
)


class DummyConnector(SourceConnector):
    """测试用连接器（无真实数据源，仅验证框架契约）。"""

    source_code = "src_dummy"
    allowed_hosts = ("data.example.org",)
    connector_version = "1.2.3"
    supports_community = False

    def health_check(self) -> SourceHealth:
        started_status = self.http.get_json("https://data.example.org/health")
        return SourceHealth(
            status=started_status["status"],
            latency_ms=started_status.get("latency_ms"),
            detail=None,
        )

    def fetch_region_data(self, region_ids, date_range):
        return [
            SourceRecord(
                source_id=self.source_code,
                object_type="region",
                object_id=region_ids[0],
                fields={},
            )
        ]


def test_community_unauthorized_returns_unsupported() -> None:
    connector = DummyConnector()
    assert connector.fetch_community_data(["c-1"], ("2026-11-01", "2026-11-07")) == UNSUPPORTED


def test_health_check_only_hits_allowlisted_endpoint() -> None:
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json={"status": "ok", "latency_ms": 120})

    http = SafeHttpClient(
        DummyConnector.allowed_hosts,
        SafeHttpConfig(min_request_interval=0.0),
        transport=httpx.MockTransport(handler),
    )
    connector = DummyConnector(http=http)
    health = connector.health_check()
    assert isinstance(health, SourceHealth)
    assert health.status == "ok"
    assert health.latency_ms == 120
    assert len(seen) == 1
    assert seen[0].startswith("https://data.example.org/health")
    http.close()


def test_default_http_client_is_bound_to_own_allowlist() -> None:
    """即使未注入 client，默认实例也只允许该连接器的白名单。"""
    connector = DummyConnector()
    with pytest.raises(Exception) as exc:
        connector.http.get_json("https://evil.example.com/x")
    assert getattr(exc.value, "code", None) == "allowlist_violation"
    connector.http.close()


def test_normalize_uses_connector_version() -> None:
    connector = DummyConnector()
    obs = connector.normalize(
        SourceRecord(
            source_id="src_dummy",
            object_type="region",
            object_id="r-1",
            fields={
                "stat_date": "2026-11-01",
                "sample_count": 5,
                "unit_price_yuan_sqm": 30000,
            },
        ),
        # 04C 起 official_index 为指数口径（禁金额）；此处测版本透传，用常规价格口径
        price_type="listing_ask",
        metric_code="city_avg_unit",
    )
    assert obs.connector_version == "1.2.3"
    assert obs.source_id == "src_dummy"


def test_source_health_rejects_invalid_status() -> None:
    with pytest.raises(ValueError):
        SourceHealth(status="healthy")
