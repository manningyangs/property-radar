# TASK-04C：青岛市统计局住宅价格指数连接器——解析、口径与范围红线
# 样例数值来自对接前手工核对（docs/TASK-04C 核验报告 §6）：
#   2026-09 期：新建 99.1/100.2、二手 95.0/99.9（2026-11-03 发布）
#   2026-08 期：新建 98.4/100.0、二手 94.6/99.8（2026-09-30 发布）
# fixture 为结构复刻合成页，非真实抓取全文（PRD §5.7）；全部零出网。
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from property_radar_collectors import (
    LIST_URL,
    IndexEntry,
    ParseError,
    QdStatsIndexConnector,
    SafeHttpConfig,
    SafeHttpClient,
    UNSUPPORTED,
    ValidationError,
    index_observations,
    parse_detail_page,
    parse_list_page,
)
from property_radar_collectors.run_daily import build_fixture_transport

FIXTURES = Path(__file__).parent / "fixtures"

# 测试专用：零节拍、零重试（fixture 全部 200，无需退避等待）
FAST = SafeHttpConfig(min_request_interval=0.0, max_retries=0)


def load_html(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def make_connector() -> QdStatsIndexConnector:
    """fixture 传输层连接器（零出网）。"""
    http = SafeHttpClient(
        QdStatsIndexConnector.allowed_hosts,
        FAST,
        transport=build_fixture_transport(str(FIXTURES)),
        allow_http_hosts=QdStatsIndexConnector.allowed_insecure_hosts,
    )
    return QdStatsIndexConnector(http=http)


def entry_for(period_year: int, period_month: int) -> IndexEntry:
    return IndexEntry(
        publish_date="2026-11-03",
        url=LIST_URL + "202611/t20261103_10767725.shtml",
        title=f"住宅销售价格指数{period_year}年{period_month}月",
        period_year=period_year,
        period_month=period_month,
    )


# ---- 列表页解析 ----


def test_parse_list_page_extracts_periods() -> None:
    entries = parse_list_page(load_html("qd_list.shtml"))
    assert len(entries) == 3  # 分页/导航 li 被排除
    first = entries[0]
    assert first.publish_date == "2026-11-03"
    assert (first.period_year, first.period_month) == (2026, 9)
    assert first.url.startswith("http://qdtj.qingdao.gov.cn/")
    assert [e.period_month for e in entries] == [9, 8, 7]


def test_parse_list_page_garbage_returns_empty() -> None:
    # 无期次条目的页面 → 空列表（调用方 fetch_region_data 将以 ParseError 拒绝）
    assert parse_list_page("<html><body><p>站点改版</p></body></html>") == []


# ---- 详情页解析（手工样例核对四值）----


def test_parse_detail_september_matches_verified_sample() -> None:
    record = parse_detail_page(load_html("t20261103_10767725.shtml"), entry_for(2026, 9))
    assert record.source_id == "qd_stats_price_index"
    assert record.object_type == "region"
    assert record.object_id == "370200"
    f = record.fields
    assert f["stat_date"] == "2026-09-30"  # 报告月月末
    assert f["sample_count"] == 0  # 来源不公布样本量
    assert f["report_period"] == "2026年9月"
    assert f["new_build_yoy_index"] == 99.1
    assert f["new_build_mom_index"] == 100.2
    assert f["resale_yoy_index"] == 95.0
    assert f["resale_mom_index"] == 99.9
    assert f["publish_date"] == "2026-11-03"
    assert "青岛调查队" in f["source_note"]


def test_parse_detail_august_matches_verified_sample() -> None:
    entry = IndexEntry(
        publish_date="2026-09-30",
        url=LIST_URL + "202609/t20260930_10745222.shtml",
        title="住宅销售价格指数2026年8月",
        period_year=2026,
        period_month=8,
    )
    record = parse_detail_page(load_html("t20260930_10745222.shtml"), entry)
    f = record.fields
    assert f["stat_date"] == "2026-08-31"
    assert (f["new_build_yoy_index"], f["new_build_mom_index"]) == (98.4, 100.0)
    assert (f["resale_yoy_index"], f["resale_mom_index"]) == (94.6, 99.8)


def test_parse_detail_no_table_raises_parse_error() -> None:
    with pytest.raises(ParseError) as exc:
        parse_detail_page("<html><body>改版后的页面</body></html>", entry_for(2026, 9))
    assert exc.value.code == "parse_error"


def test_parse_detail_period_mismatch_rejected() -> None:
    with pytest.raises(ValidationError) as exc:
        parse_detail_page(load_html("t20261103_10767725.shtml"), entry_for(2026, 8))
    assert "不一致" in str(exc.value)


def test_parse_detail_missing_data_row_rejected() -> None:
    html = load_html("t20261103_10767725.shtml").replace("二手住宅销售价格指数", "其它指标")
    with pytest.raises(ValidationError) as exc:
        parse_detail_page(html, entry_for(2026, 9))
    assert "缺少新建或二手" in str(exc.value)


def test_parse_detail_non_numeric_rejected() -> None:
    html = load_html("t20261103_10767725.shtml").replace(">99.1<", ">暂无<")
    with pytest.raises(ValidationError) as exc:
        parse_detail_page(html, entry_for(2026, 9))
    assert "不是数值" in str(exc.value)


# ---- 归一化观测：每期 ×2 指标、index_value=同比 ----


def test_index_observations_two_per_period() -> None:
    record = parse_detail_page(load_html("t20261103_10767725.shtml"), entry_for(2026, 9))
    obs = index_observations(record)
    assert len(obs) == 2
    by_metric = {o.metric_code: o for o in obs}
    assert set(by_metric) == {"new_house_price_index", "second_hand_price_index"}
    new = by_metric["new_house_price_index"]
    resale = by_metric["second_hand_price_index"]
    assert new.property_type == "new_build"
    assert new.index_value == 99.1  # 同比列
    assert resale.property_type == "resale"
    assert resale.index_value == 95.0
    for o in obs:
        assert o.price_type == "official_index"
        assert o.price_total_fen is None and o.unit_price_yuan_sqm is None
        assert o.stat_date == "2026-09-30"
        assert o.sample_count == 0
        assert o.connector_version == QdStatsIndexConnector.connector_version


# ---- 连接器：范围红线与采集行为 ----


def test_fetch_region_rejects_unauthorized_region() -> None:
    connector = make_connector()
    with pytest.raises(ValidationError) as exc:
        connector.fetch_region_data(["370300"], ("2026-10-01", "2026-11-11"))
    assert "超出授权区域" in str(exc.value)
    connector.http.close()


def test_fetch_region_rejects_inverted_date_range() -> None:
    connector = make_connector()
    with pytest.raises(ValidationError) as exc:
        connector.fetch_region_data(["370200"], ("2026-11-11", "2026-10-01"))
    assert "date_range" in str(exc.value)
    connector.http.close()


def test_fetch_region_filters_by_publish_date() -> None:
    """45 天回放窗口（2026-11-05 起 → 2026-09-21）：含 11-03/09-30 两期，排除 09-02 的 7 月期。"""
    connector = make_connector()
    records = connector.fetch_region_data(["370200"], ("2026-09-21", "2026-11-11"))
    assert [r.fields["report_period"] for r in records] == ["2026年9月", "2026年8月"]
    connector.http.close()


def test_fetch_region_window_excluding_both_returns_empty() -> None:
    connector = make_connector()
    records = connector.fetch_region_data(["370200"], ("2026-11-04", "2026-11-11"))
    assert records == []
    connector.http.close()


def test_fetch_community_unsupported() -> None:
    connector = make_connector()
    assert connector.fetch_community_data(["c-1"], ("2026-11-01", "2026-11-11")) is UNSUPPORTED
    connector.http.close()


def test_health_check_ok_via_fixture() -> None:
    connector = make_connector()
    health = connector.health_check()
    assert health.status == "ok"
    assert health.latency_ms is not None and health.latency_ms >= 0
    connector.http.close()


def test_health_check_down_on_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, request=request)

    http = SafeHttpClient(
        QdStatsIndexConnector.allowed_hosts,
        FAST,
        transport=httpx.MockTransport(handler),
        allow_http_hosts=QdStatsIndexConnector.allowed_insecure_hosts,
    )
    connector = QdStatsIndexConnector(http=http)
    health = connector.health_check()
    assert health.status == "down"
    assert "不可达" in (health.detail or "")
    assert "retries_exhausted" in (health.detail or "")  # 500 → 重试用尽（max_retries=0）
    http.close()


def test_fetch_region_list_garbage_raises_parse_error() -> None:
    """列表页结构变化 → ParseError（不得静默记成功）。"""
    http = SafeHttpClient(
        QdStatsIndexConnector.allowed_hosts,
        FAST,
        transport=httpx.MockTransport(
            lambda request: httpx.Response(
                200,
                text="<html><body><p>改版</p></body></html>",
                headers={"content-type": "text/html; charset=utf-8"},
                request=request,
            )
        ),
        allow_http_hosts=QdStatsIndexConnector.allowed_insecure_hosts,
    )
    connector = QdStatsIndexConnector(http=http)
    with pytest.raises(ParseError) as exc:
        connector.fetch_region_data(["370200"], ("2026-10-01", "2026-11-11"))
    assert "改版" in str(exc.value)
    http.close()


def test_http_only_host_is_static_exception() -> None:
    """全站 http 的例外必须是静态常量且为白名单子集（fail closed 不变）。"""
    assert QdStatsIndexConnector.allowed_insecure_hosts
    assert set(QdStatsIndexConnector.allowed_insecure_hosts) <= set(
        QdStatsIndexConnector.allowed_hosts
    )
