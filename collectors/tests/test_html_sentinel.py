# TASK-04E SubTask 4.2（spec R5）：HTML 哨兵——14 个 fang/qingdao fixture HTML 内埋
# SENTINEL_RAW_HTML 哨兵串（HTML 注释 + <div>，位于解析区之外），断言解析/归一化/
# 异常三层产物零哨兵、零 <div 标签——落实「不存原始 HTML、异常消息零页面正文」。
# submit_batch 载荷级断言在 test_fang_community / test_run_daily 的全链测试内。
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from property_radar_collectors import (
    LIST_URL,
    IndexEntry,
    ParseError,
    ValidationError,
    index_observations,
    parse_detail_page,
    parse_list_page,
)
from property_radar_collectors.fang_community import parse_listing_cards
from property_radar_collectors.schema import SourceRecord, normalize_record

SENTINEL = "SENTINEL_RAW_HTML"
FANG_DIR = Path(__file__).parent / "fixtures" / "fang"
FIXTURES = Path(__file__).parent / "fixtures"

FANG_FIXTURES = sorted(FANG_DIR.glob("*.html"))
QINGDAO_FIXTURES = [
    FIXTURES / "qd_list.shtml",
    FIXTURES / "t20260930_10745222.shtml",
    FIXTURES / "t20261103_10767725.shtml",
]


def assert_no_raw_html(blob: str, where: str) -> None:
    """结构化产物零原始 HTML：无哨兵串、无 <div 标签。"""
    assert SENTINEL not in blob, f"{where} 泄漏原始 HTML 哨兵"
    assert "<div" not in blob, f"{where} 泄漏原始 HTML 标签"


def make_entry(period_year: int, period_month: int) -> IndexEntry:
    return IndexEntry(
        publish_date="2026-11-03",
        url=LIST_URL + "202611/t20261103_10767725.shtml",
        title=f"住宅销售价格指数{period_year}年{period_month}月",
        period_year=period_year,
        period_month=period_month,
    )


def test_fixtures_all_embed_sentinel() -> None:
    """哨兵确实埋入全部 fang/qingdao HTML fixture（后续零泄漏断言的前提）。"""
    files = FANG_FIXTURES + QINGDAO_FIXTURES
    assert len(files) == 14
    for p in files:
        assert SENTINEL in p.read_text(encoding="utf-8"), p.name


def test_fang_source_record_and_observation_carry_no_raw_html() -> None:
    """fang 解析 → SourceRecord.fields → NormalizedObservation → to_ingest_item 零哨兵。"""
    total_cards = 0
    for p in FANG_FIXTURES:
        html = p.read_text(encoding="utf-8")
        cards = parse_listing_cards(html)
        total_cards += len(cards)
        for fields in cards:
            record = SourceRecord(
                source_id="fang_com",
                object_type="community",
                object_id="cmt_sentinel",
                fields={"stat_date": "2026-11-12", "sample_count": 1, **fields},
            )
            # fields 键白名单：只含业务字段（loupan_id 仅溯源不入库）
            assert set(record.fields) <= {
                "stat_date",
                "sample_count",
                "total_price_yuan",
                "unit_price_yuan_sqm",
                "area_sqm",
                "loupan_id",
            }
            assert_no_raw_html(
                json.dumps(asdict(record), ensure_ascii=False), p.name
            )
            try:
                obs = normalize_record(
                    record,
                    price_type="listing_ask",
                    metric_code="listing_ask_unit",
                    connector_version="fang_community/0.1.0",
                )
            except ValidationError as exc:
                # 客户端拒绝（如极端价格）：异常消息同样零页面正文
                assert_no_raw_html(str(exc), p.name)
                continue
            assert_no_raw_html(
                json.dumps(obs.to_ingest_item(), ensure_ascii=False), p.name
            )
    # 哨兵注入未吞解析产物（全链 25 套卡片口径，见 test_fang_community）
    assert total_cards >= 24


def test_qingdao_records_and_index_observations_carry_no_raw_html() -> None:
    """qingdao 列表/详情解析 → SourceRecord → 每期 4 条指数观测零哨兵。"""
    entries = parse_list_page(
        (FIXTURES / "qd_list.shtml").read_text(encoding="utf-8")
    )
    assert len(entries) == 3
    assert_no_raw_html(
        json.dumps([asdict(e) for e in entries], ensure_ascii=False), "qd_list"
    )

    html = (FIXTURES / "t20261103_10767725.shtml").read_text(encoding="utf-8")
    record = parse_detail_page(html, make_entry(2026, 9))
    assert_no_raw_html(
        json.dumps(asdict(record), ensure_ascii=False), "detail record"
    )
    observations = index_observations(record)
    assert len(observations) == 4
    for obs in observations:
        assert_no_raw_html(
            json.dumps(obs.to_ingest_item(), ensure_ascii=False),
            "index observation",
        )


def test_parse_error_message_carries_no_page_body() -> None:
    """解析失败的 ParseError 消息零页面正文（不回显 HTML 片段/哨兵）。"""
    body = (
        '<html><body><div class="SENTINEL_RAW_HTML">SENTINEL_RAW_HTML</div>'
        "<p>SECRET_BODY_04E 改版后的页面正文</p></body></html>"
    )
    with pytest.raises(ParseError) as exc:
        parse_detail_page(body, make_entry(2026, 9))
    assert exc.value.code == "parse_error"
    msg = str(exc.value)
    assert SENTINEL not in msg
    assert "<div" not in msg
    assert "SECRET_BODY_04E" not in msg
    assert "改版后的页面正文" not in msg
