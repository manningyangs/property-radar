# TASK-04C：run_daily 每日运行 CLI——全链顺序、HMAC 签名、载荷与失败路径
# 全部经 MockTransport 注入（pytest 零出网）：
#   API 侧：模拟 internal 端点并逐请求对拍 HMAC 签名；
#   源侧：fixture 目录回放（结构复刻合成页）。
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest

from property_radar_collectors import SafeHttpConfig, SafeHttpClient, run_daily
from property_radar_collectors.internal_client import InternalApiClient
from property_radar_collectors.run_daily import build_fixture_transport, main

FIXTURES = str(Path(__file__).parent / "fixtures")
SECRET = "test-secret-04c"
API_BASE = "https://internal.test"

FAST = SafeHttpConfig(min_request_interval=0.0, max_retries=0)


@pytest.fixture
def fast_http(monkeypatch):
    """把 run_daily 构建的源客户端改为零节拍/零重试（测试提速，行为不变）。"""
    real_cls = run_daily.SafeHttpClient

    def factory(hosts, config=None, transport=None, allow_http_hosts=()):
        return real_cls(hosts, FAST, transport=transport, allow_http_hosts=allow_http_hosts)

    monkeypatch.setattr(run_daily, "SafeHttpClient", factory)


@pytest.fixture
def secret(monkeypatch):
    monkeypatch.setenv("INGEST_HMAC_SECRET", SECRET)
    monkeypatch.delenv("API_BASE", raising=False)
    return SECRET


class ApiEmulator:
    """internal API 模拟器：记录事件顺序 + 对拍每请求 HMAC 签名。"""

    def __init__(self, *, deny_eligibility: bool = False):
        self.deny_eligibility = deny_eligibility
        self.events: list[tuple[str, dict]] = []
        self.signature_errors: list[str] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handler)

    def _handler(self, request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path
        raw = request.content.decode("utf-8")
        # 签名对拍：HMAC(secret, ts.nonce.body)，与服务端同口径（§10.4）
        expected = InternalApiClient.sign(
            SECRET,
            request.headers.get("X-Ingest-Timestamp", ""),
            request.headers.get("X-Ingest-Nonce", ""),
            raw,
        )
        if request.headers.get("X-Ingest-Signature") != expected:
            self.signature_errors.append(path)
        payload = json.loads(raw) if raw else {}

        if path.endswith("/eligibility"):
            self.events.append(("eligibility", payload))
            if self.deny_eligibility:
                return httpx.Response(
                    403,
                    json={"error_code": "source_not_approved", "message": "来源未批准"},
                    request=request,
                )
            return httpx.Response(
                200,
                json={
                    "eligible": True,
                    "source_id": "qd_stats_price_index",
                    "status": "approved_open",
                    "valid_until": None,
                },
                request=request,
            )
        if path.endswith("/health/source"):
            self.events.append(("health", payload))
        elif path.endswith("/jobs/start"):
            self.events.append(("jobs/start", payload))
        elif path.endswith("/ingest/batch"):
            self.events.append(("batch", payload))
        elif path.endswith("/finish"):
            self.events.append(("jobs/finish", payload))
        else:
            return httpx.Response(
                404, json={"error_code": "not_found"}, request=request
            )
        return httpx.Response(200, json={"ok": True}, request=request)

    def names(self) -> list[str]:
        return [name for name, _ in self.events]

    def payload(self, name: str) -> dict:
        for event_name, body in self.events:
            if event_name == name:
                return body
        raise AssertionError(f"事件不存在：{name}（实际：{self.names()}）")


def run_cli(monkeypatch, emu: ApiEmulator, *extra: str) -> int:
    monkeypatch.setenv("INGEST_HMAC_SECRET", SECRET)
    argv = ["--api-base", API_BASE, *extra]
    return main(argv, api_transport=emu.transport())


def test_full_chain_order_signature_and_payload(monkeypatch, secret, fast_http) -> None:
    """成功回放：eligibility → health → jobs/start → batch → finish，签名全对拍。"""
    emu = ApiEmulator()
    source_calls: list[str] = []
    inner = build_fixture_transport(FIXTURES)

    def recording(request: httpx.Request) -> httpx.Response:
        source_calls.append(f"{request.url.scheme}://{request.url.host}")
        return inner.handle_request(request)

    code = main(
        [
            "--api-base",
            API_BASE,
            "--run-date",
            "2026-11-05",
        ],
        api_transport=emu.transport(),
        source_transport=httpx.MockTransport(recording),
    )
    assert code == 0
    assert emu.signature_errors == []
    # 严格顺序：先资格预检，且资格之后才有任何源请求（04B 验收二）
    assert emu.names() == ["eligibility", "health", "jobs/start", "batch", "jobs/finish"]

    assert emu.payload("eligibility") == {"city_code": "370200", "object_level": "city"}
    health = emu.payload("health")
    assert health["source_id"] == "qd_stats_price_index"
    assert health["status"] == "ok"
    assert health["latency_ms"] >= 0

    start = emu.payload("jobs/start")
    assert start == {
        "job_id": "qd_idx_2026-11-05",
        "source_id": "qd_stats_price_index",
        "city_code": "370200",
        "object_level": "city",
    }

    batch = emu.payload("batch")
    assert batch["batch_id"] == "qd_batch_2026-11-05"
    assert batch["observed_count"] == 8  # 2 期 × 4（双口径：同比/环比 × 新建/二手）
    assert batch["object_level"] == "city"
    # TASK-04E：批次携带 observations 明细，长度与 observed_count 一致（服务端 04D 交叉校验）
    obs_items = batch["observations"]
    assert len(obs_items) == batch["observed_count"] == 8
    assert {o["metric_code"] for o in obs_items} == {
        "new_house_price_index",
        "new_house_price_index_mom",
        "second_hand_price_index",
        "second_hand_price_index_mom",
    }
    for o in obs_items:
        assert o["price_type"] == "official_index"
        assert o["index_value"] is not None
        assert 0 < o["index_value"] <= 1000  # 服务端 schema/cleaning 同口径
        assert o["sample_count"] == 0
        # 指数口径禁金额/面积（04E 互斥清洗同断言）
        assert o["price_total_fen"] is None and o["unit_price_yuan_sqm"] is None
        assert o["area_sqm"] is None
        assert o["object_id"] == "370200"

    finish = emu.payload("jobs/finish")
    assert finish["status"] == "succeeded"
    assert "2026年9月" in finish["note"] and "2026年8月" in finish["note"]

    # 源侧只访问白名单主机（fixture 回放零出网）
    assert source_calls
    assert set(source_calls) == {"http://qdtj.qingdao.gov.cn"}

    # TASK-04E R5 HTML 哨兵：批次载荷零原始 HTML——哨兵串与 <div 均不透传
    batch_json = json.dumps(emu.payload("batch"), ensure_ascii=False)
    assert "SENTINEL_RAW_HTML" not in batch_json
    assert "<div" not in batch_json
    # 拒绝计数口径（run_daily.py 注释）：客户端构建期零拒绝，note 只记
    # run_date/期次/观测；规范拒绝由服务端 04E 清洗以 400 details 留痕
    assert "观测=8" in finish["note"]
    assert "拒绝=" not in finish["note"]


def test_not_approved_zero_collection(monkeypatch, secret, fast_http) -> None:
    """资格 403 → 无 health/任务/批次/源请求，返回 1（零采集）。"""
    emu = ApiEmulator(deny_eligibility=True)
    source_calls: list[str] = []
    inner = build_fixture_transport(FIXTURES)

    def recording(request: httpx.Request) -> httpx.Response:
        source_calls.append(str(request.url))
        return inner.handle_request(request)

    code = main(
        ["--api-base", API_BASE, "--run-date", "2026-11-05", "--fixture", FIXTURES],
        api_transport=emu.transport(),
        source_transport=httpx.MockTransport(recording),
    )
    assert code == 1
    assert emu.names() == ["eligibility"]
    assert source_calls == []


def test_fetch_failure_records_failed_job(monkeypatch, secret, fast_http) -> None:
    """采集失败（源 404）→ jobs/finish(failed, error_code)，返回 1。"""
    emu = ApiEmulator()

    def broken(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, request=request)

    code = main(
        ["--api-base", API_BASE, "--run-date", "2026-11-05"],
        api_transport=emu.transport(),
        source_transport=httpx.MockTransport(broken),
    )
    assert code == 1
    assert emu.names() == ["eligibility", "health", "jobs/start", "jobs/finish"]
    finish = emu.payload("jobs/finish")
    assert finish["status"] == "failed"
    assert finish["error_code"] == "http_status_error"
    # 未提交任何批次
    assert "batch" not in emu.names()
    assert emu.signature_errors == []


def test_missing_api_base_returns_2(monkeypatch, secret) -> None:
    """缺 --api-base 与 API_BASE → 2，且不产生任何请求。"""
    emu = ApiEmulator()
    assert main([], api_transport=emu.transport()) == 2
    assert emu.names() == []


def test_bad_run_date_returns_2(monkeypatch, secret) -> None:
    emu = ApiEmulator()
    assert run_cli(monkeypatch, emu, "--run-date", "11/05/2026") == 2
    assert emu.names() == []


def test_missing_secret_internal_unavailable(monkeypatch, fast_http) -> None:
    """INGEST_HMAC_SECRET 缺失 → internal 端点禁用，返回 1（不采集）。"""
    monkeypatch.delenv("INGEST_HMAC_SECRET", raising=False)
    emu = ApiEmulator()
    code = main(
        ["--api-base", API_BASE, "--run-date", "2026-11-05", "--fixture", FIXTURES],
        api_transport=emu.transport(),
    )
    assert code == 1
    assert emu.names() == []
