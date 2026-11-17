# TASK-09：贝壳小区连接器与 run_beike 全链（spec R1 / 验收一、二、五）
# 全部经 MockTransport 注入（pytest 零出网）：
#   解析：fixture 列表页 → 卡片字段（含广告跳过 / 30 套上限 / 极端价格拒绝）；
#   边界：登录/验证挑战页识别不绕过（health down / ParseError）、302 登录墙如实失败；
#   门禁：beike 未 approved → 零采集请求终止；
#   全链：eligibility → health → jobs/start → batch×2(observations) → finish，
#         无 listing_url 的 14 个小区零请求跳过，源侧只访问 qd.ke.com。
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlparse

import httpx
import pytest

from property_radar_collectors import SafeHttpConfig, SafeHttpClient
from property_radar_collectors import run_beike
from property_radar_collectors.beike_community import (
    MAX_LISTINGS_PER_COMMUNITY,
    BeikeCommunityConnector,
    is_challenge_page,
    load_communities,
    parse_listing_cards,
)
from property_radar_collectors.errors import ParseError, ValidationError
from property_radar_collectors.internal_client import InternalApiClient
from property_radar_collectors.run_beike import build_fixture_transport, main

BEIKE_FIXTURES = str(Path(__file__).parent / "fixtures" / "beike")
SECRET = "test-secret-09"
API_BASE = "https://internal.test"
RUN_DATE = "2026-11-17"

FAST = SafeHttpConfig(min_request_interval=0.0, max_retries=0)

#: 有 listing_url 的小区数（其余 14 个公开渠道不可核验，零请求跳过）
WITH_URL = 2
#: fixture 中可归一化的观测总数（8 套解析产物 − 1 套极端价格被护栏拒绝）
EXPECTED_OBSERVATIONS = 7


@pytest.fixture
def fast_http(monkeypatch):
    """把 run_beike 构建的源客户端改为零节拍/零重试（测试提速，行为不变）。"""
    real_cls = run_beike.SafeHttpClient

    def factory(hosts, config=None, transport=None, allow_http_hosts=()):
        return real_cls(hosts, FAST, transport=transport, allow_http_hosts=allow_http_hosts)

    monkeypatch.setattr(run_beike, "SafeHttpClient", factory)


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
                    "source_id": "beike",
                    "status": "approved_licensed",
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

    def payloads(self, name: str) -> list[dict]:
        return [body for event_name, body in self.events if event_name == name]

    def payload(self, name: str) -> dict:
        found = self.payloads(name)
        assert found, f"事件不存在：{name}（实际：{self.names()}）"
        return found[0]


def fixture_source_calls() -> tuple[httpx.MockTransport, list[str]]:
    """fixture 回放传输层 + 源请求记录（断言零出网与白名单主机）。"""
    source_calls: list[str] = []
    inner = build_fixture_transport(BEIKE_FIXTURES)

    def recording(request: httpx.Request) -> httpx.Response:
        source_calls.append(f"{request.url.scheme}://{request.url.host}")
        return inner.handle_request(request)

    return httpx.MockTransport(recording), source_calls


# ---------------- 解析层（纯函数） ----------------


def test_parse_listing_cards_fields_and_ad_skip() -> None:
    """fixture 卡片 → 总价/单价/面积数值；广告位跳过；仅单价卡保留单价。"""
    html = (Path(BEIKE_FIXTURES) / "1511063904841.html").read_text(encoding="utf-8")
    cards = parse_listing_cards(html)
    # 3 正常 + 1 仅单价 + 1 极端价格（解析层不过滤）；广告位（无价格块）被跳过
    assert len(cards) == 5
    first = cards[0]
    assert first["total_price_yuan"] == 1_580_000.0
    assert first["unit_price_yuan_sqm"] == 12296
    assert first["area_sqm"] == 128.5
    # 仅单价卡：无总价、有单价与面积
    unit_only = cards[3]
    assert "total_price_yuan" not in unit_only
    assert unit_only["unit_price_yuan_sqm"] == 13500
    assert unit_only["area_sqm"] == 96.0
    # 标题含"万"字（如"万象城"）不误抽：总价只从 totalPrice 块提取
    assert all(c.get("total_price_yuan") or c.get("unit_price_yuan_sqm") for c in cards)


def test_title_with_wan_char_not_misextracted() -> None:
    """标题含"万"（万象城旁）但无 totalPrice 块 → 不产出总价。"""
    html = (
        "<html><li class=\"clear\"><div class=\"info\">"
        "<div class=\"title\">万象城旁 好房</div>"
        "<div class=\"houseInfo\">2室1厅 | 80.0平米 | 南</div>"
        "<div class=\"priceInfo\"><div class=\"unitPrice\"><span>11000元/㎡</span></div></div>"
        "</div></li></html>"
    )
    cards = parse_listing_cards(html)
    assert len(cards) == 1
    assert "total_price_yuan" not in cards[0]
    assert cards[0]["unit_price_yuan_sqm"] == 11000


def test_parse_listing_cards_capped_at_30() -> None:
    """每小区最多 30 套（spec R1 上限，结构化强制）。"""
    one = (
        '<li class="clear"><div class="priceInfo">'
        '<div class="totalPrice"><span>300</span><i>万</i></div>'
        '<div class="unitPrice"><span>30000元/㎡</span></div></div></li>'
    )
    html = "<html>" + one * 35 + "</html>"
    assert len(parse_listing_cards(html)) == MAX_LISTINGS_PER_COMMUNITY


def test_challenge_page_detected_and_not_bypassed() -> None:
    """登录/验证挑战页：识别后如实失败，不解析、不绕过。"""
    challenge = "<html><body><div class=\"verify\">请完成下方人机验证后继续访问</div></body></html>"
    assert is_challenge_page(challenge)
    assert not is_challenge_page("<html><title>正常页</title></html>")

    connector = BeikeCommunityConnector(
        http=SafeHttpClient(
            BeikeCommunityConnector.allowed_hosts,
            FAST,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200, content=challenge.encode("utf-8"), request=request
                )
            ),
        )
    )
    community = {
        "community_id": "cmt_qd_12",
        "listing_url": "https://qd.ke.com/ershoufang/c1511063904841/",
    }
    with pytest.raises(ParseError):
        connector.fetch_community_listings(community, RUN_DATE)
    health = connector.health_check()
    assert health.status == "down"
    assert "不绕过" in (health.detail or "")


def test_login_wall_302_fails_honestly() -> None:
    """真实登录墙形态（302→clogin，不回显体）：不跟随重定向，逐小区如实记失败。"""
    connector = BeikeCommunityConnector(
        http=SafeHttpClient(
            BeikeCommunityConnector.allowed_hosts,
            FAST,
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    302,
                    headers={"location": "https://clogin.ke.com/login?service=xxx"},
                    request=request,
                )
            ),
        )
    )
    health = connector.health_check()
    assert health.status == "down"
    community = {
        "community_id": "cmt_qd_12",
        "listing_url": "https://qd.ke.com/ershoufang/c1511063904841/",
    }
    with pytest.raises(Exception):
        connector.fetch_community_listings(community, RUN_DATE)


def test_normalize_rejects_extreme_listing() -> None:
    """极端价格单套被 normalize 护栏拒绝（拒绝≠丢弃：运行侧计数如实上报）。"""
    from property_radar_collectors.schema import SourceRecord

    html = (Path(BEIKE_FIXTURES) / "1511063904841.html").read_text(encoding="utf-8")
    connector = BeikeCommunityConnector()
    records = [
        SourceRecord(
            source_id="beike",
            object_type="community",
            object_id="cmt_qd_12",
            fields={"stat_date": RUN_DATE, "sample_count": 1, **f},
        )
        for f in parse_listing_cards(html)
    ]
    ok, rejected = 0, 0
    for record in records:
        try:
            connector.normalize(
                record, price_type="listing_ask", metric_code="listing_ask_unit"
            )
            ok += 1
        except ValidationError:
            rejected += 1
    assert ok == 4
    assert rejected == 1  # 2000 万 / 15 万元/㎡ 极端卡


def test_load_communities_config() -> None:
    """配置：16 小区（00B 清单）→ 2 有 URL（公开可核验）、14 无 URL。"""
    entries = load_communities()
    assert len(entries) == 16
    with_url = [c for c in entries if c.get("listing_url")]
    no_url = [c for c in entries if not c.get("listing_url")]
    assert len(with_url) == WITH_URL
    assert len(no_url) == 14
    assert all(
        u.startswith("https://qd.ke.com/")
        for u in (c["listing_url"] for c in with_url)
    )


def test_whitelist_only_qd_ke_com() -> None:
    """静态白名单仅 qd.ke.com（链家/其他域拒绝，fail closed）。"""
    assert BeikeCommunityConnector.allowed_hosts == ("qd.ke.com",)
    assert BeikeCommunityConnector.allowed_insecure_hosts == ()


def test_fetch_community_data_interface() -> None:
    """小区级接口：有 URL 解析出卡片、无 URL 零请求返回空、未知 ID 抛错。"""
    connector = BeikeCommunityConnector(
        http=SafeHttpClient(
            BeikeCommunityConnector.allowed_hosts,
            FAST,
            transport=build_fixture_transport(BEIKE_FIXTURES),
        )
    )
    records = connector.fetch_community_data(["cmt_qd_12"], (RUN_DATE, RUN_DATE))
    assert len(records) == 5  # 3 正常 + 1 仅单价 + 1 极端卡（normalize 层拒绝）
    assert all(r.object_type == "community" for r in records)
    assert all(r.object_id == "cmt_qd_12" for r in records)
    assert all(r.fields["stat_date"] == RUN_DATE for r in records)
    assert all(r.fields["sample_count"] == 1 for r in records)

    # 无 listing_url 的小区（cmt_qd_01 新贵都）零请求返回空
    assert connector.fetch_community_data(["cmt_qd_01"], (RUN_DATE, RUN_DATE)) == []

    with pytest.raises(ParseError):
        connector.fetch_community_data(["cmt_not_exist"], (RUN_DATE, RUN_DATE))


# ---------------- 全链（CLI） ----------------


def test_full_chain_batches_per_community(monkeypatch, secret, fast_http) -> None:
    """成功回放：门禁→健康→任务→2 批次（每批 observations）→完成，签名全对拍。"""
    emu = ApiEmulator()
    transport, source_calls = fixture_source_calls()

    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE],
        api_transport=emu.transport(),
        source_transport=transport,
    )
    assert code == 0
    assert emu.signature_errors == []
    names = emu.names()
    assert names[0] == "eligibility"
    assert names[1] == "health"
    assert names[2] == "jobs/start"
    assert names[-1] == "jobs/finish"
    assert names.count("batch") == WITH_URL

    assert emu.payload("eligibility") == {
        "city_code": "370200",
        "object_level": "community",
    }
    health = emu.payload("health")
    assert health["source_id"] == "beike"
    assert health["status"] == "ok"

    start = emu.payload("jobs/start")
    assert start == {
        "job_id": f"qd_beike_{RUN_DATE}",
        "source_id": "beike",
        "city_code": "370200",
        "object_level": "community",
    }

    batches = emu.payloads("batch")
    assert len(batches) == WITH_URL
    batch_ids = {b["batch_id"] for b in batches}
    assert len(batch_ids) == WITH_URL
    assert all(bid.startswith(f"qd_beike_{RUN_DATE}_") for bid in batch_ids)
    total = 0
    for b in batches:
        assert b["source_id"] == "beike"
        assert b["city_code"] == "370200"
        assert b["object_level"] == "community"
        obs = b["observations"]
        assert b["observed_count"] == len(obs)
        assert 1 <= len(obs) <= MAX_LISTINGS_PER_COMMUNITY
        total += len(obs)
        for o in obs:
            assert o["object_id"].startswith("cmt_qd_")
            assert o["price_type"] == "listing_ask"
            assert o["metric_code"] == "listing_ask_unit"
            assert o["stat_date"] == RUN_DATE
            assert o["sample_count"] == 1
            assert o["quality_status"] == "valid"
            assert o["connector_version"].startswith("beike_community/")
            assert o["price_total_fen"] is not None or o["unit_price_yuan_sqm"] is not None
    assert total == EXPECTED_OBSERVATIONS

    finish = emu.payload("jobs/finish")
    assert finish["status"] == "succeeded"
    assert "无链接跳过=14" in finish["note"]
    assert f"观测={EXPECTED_OBSERVATIONS}" in finish["note"]
    assert "拒绝=1" in finish["note"]

    # 源侧只访问白名单主机（fixture 回放零出网）
    assert source_calls
    assert set(source_calls) == {"https://qd.ke.com"}

    # HTML 哨兵：批次载荷零原始 HTML——<div 均不透传
    batch_json = json.dumps(emu.payloads("batch"), ensure_ascii=False)
    assert "<div" not in batch_json


def test_not_approved_zero_collection(monkeypatch, secret, fast_http) -> None:
    """资格 403 → 无健康/任务/批次/源请求，返回 1（04B 验收二回归）。"""
    emu = ApiEmulator(deny_eligibility=True)
    transport, source_calls = fixture_source_calls()

    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE],
        api_transport=emu.transport(),
        source_transport=transport,
    )
    assert code == 1
    assert emu.names() == ["eligibility"]
    assert source_calls == []


def test_login_wall_job_failed_honestly(monkeypatch, secret, fast_http) -> None:
    """全站登录墙（302→clogin）：零批次，任务如实 failed（不伪造成功），返回 1。"""
    emu = ApiEmulator()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"location": "https://clogin.ke.com/login?service=xxx"},
            request=request,
        )

    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE],
        api_transport=emu.transport(),
        source_transport=httpx.MockTransport(handler),
    )
    assert code == 1
    finish = emu.payload("jobs/finish")
    assert finish["status"] == "failed"
    assert finish["error_code"] == "all_communities_failed"
    assert "批次=0" in finish["note"]
    assert "cmt_qd_12:http_status_error" in finish["note"]
    health = emu.payload("health")
    assert health["status"] == "down"


def test_one_community_404_continues_others(monkeypatch, secret, fast_http) -> None:
    """单小区源 404 → 记失败明细继续其余小区，整体仍成功。"""
    emu = ApiEmulator()
    inner = build_fixture_transport(BEIKE_FIXTURES)
    source_calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        source_calls.append(f"{request.url.scheme}://{request.url.host}")
        if "1511063904841" in str(request.url):  # 千禧龙花园页 404
            return httpx.Response(404, request=request)
        return inner.handle_request(request)

    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE],
        api_transport=emu.transport(),
        source_transport=httpx.MockTransport(handler),
    )
    assert code == 0
    assert emu.names().count("batch") == WITH_URL - 1
    finish = emu.payload("jobs/finish")
    assert finish["status"] == "succeeded"
    assert "cmt_qd_12:http_status_error" in finish["note"]


def test_limit_parameter(monkeypatch, secret, fast_http) -> None:
    """--limit N：只跑前 N 个有 URL 的小区（health 1 + N 小区页 = N+1 次源请求）。"""
    emu = ApiEmulator()
    transport, source_calls = fixture_source_calls()
    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE, "--limit", "1"],
        api_transport=emu.transport(),
        source_transport=transport,
    )
    assert code == 0
    assert emu.names().count("batch") == 1
    assert len(source_calls) == 2


def test_missing_api_base_returns_2(monkeypatch, secret) -> None:
    """缺 --api-base 与 API_BASE → 2，且不产生任何请求。"""
    emu = ApiEmulator()
    assert main([], api_transport=emu.transport()) == 2
    assert emu.names() == []


def test_bad_run_date_returns_2(monkeypatch, secret) -> None:
    """--run-date 非 YYYY-MM-DD → 2，零请求。"""
    emu = ApiEmulator()
    code = main(
        ["--api-base", API_BASE, "--run-date", "11/17/2026"],
        api_transport=emu.transport(),
    )
    assert code == 2
    assert emu.names() == []


def test_missing_secret_internal_unavailable(monkeypatch, fast_http) -> None:
    """INGEST_HMAC_SECRET 缺失 → internal 端点禁用，返回 1（不采集）。"""
    monkeypatch.delenv("INGEST_HMAC_SECRET", raising=False)
    emu = ApiEmulator()
    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE],
        api_transport=emu.transport(),
    )
    assert code == 1
    assert emu.names() == []


def test_fixture_mode_zero_network(monkeypatch, secret, fast_http) -> None:
    """--fixture 离线回放：fixture 传输层完全取代注入的网络传输层——零出网，退出码 0。"""
    emu = ApiEmulator()
    calls: list[str] = []
    inner = build_fixture_transport(BEIKE_FIXTURES)

    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return inner.handle_request(request)

    code = main(
        ["--api-base", API_BASE, "--run-date", RUN_DATE, "--fixture", BEIKE_FIXTURES],
        api_transport=emu.transport(),
        source_transport=httpx.MockTransport(recording),
    )
    assert code == 0
    assert calls == []
    assert emu.names().count("batch") == WITH_URL
