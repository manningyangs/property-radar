# TASK-04C：青岛市统计局住宅价格指数连接器（PRD §5.5 政府和统计数据 / §5.6 连接器规范 /
# 任务行 1296–1302：核验许可、字段、区域、频率与口径后接入的首个官方数据源）
# - 白名单仅 qdtj.qingdao.gov.cn；全站 http（https 证书主机名不匹配），以静态 allow_http_hosts
#   例外放行该主机的明文 http（见核验报告 §1，仍先于一切网络 I/O 校验，fail closed 不变）。
# - 解析列表页 + 每期详情页单表格；每期产出 1 条 SourceRecord（四值原始字段保留，不落原始 HTML §5.7）。
# - 归一化观测：每期 ×2 指标（新建/二手），index_value 取同比列（本月，上年同月=100），
#   price_type="official_index"，stat_date=报告月月末，sample_count=0（来源不公布样本量，禁止造数）。
#   环比列保留在 SourceRecord.fields（供 04E 清洗落库时决定口径映射）。
from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date
from typing import Sequence
from urllib.parse import urljoin

from .connector import SourceConnector, SourceHealth, UNSUPPORTED
from .errors import ConnectorError, ParseError, ValidationError
from .schema import NormalizedObservation, SourceRecord, normalize_record

#: 栏目列表页（对接前人工核验；见 docs/TASK-04C-…核验报告 §6）
LIST_URL = "http://qdtj.qingdao.gov.cn/tongjisj/tjsj_42452/tjj_tjsj_jgzs/zzjgzs/"
#: 授权覆盖的唯一区域（市级；source_city_coverage 仅授权 370200/city）
AUTHORIZED_REGION = "370200"

_LI_RE = re.compile(r"<li[^>]*>(.*?)</li>", re.S)
_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
_HREF_RE = re.compile(r"""href\s*=\s*["']([^"']+\.shtml)["']""", re.I)
_TITLE_ATTR_RE = re.compile(r"""title\s*=\s*["']([^"']+)["']""", re.I)
_PERIOD_RE = re.compile(r"住宅销售价格指数\s*(\d{4})年\s*(\d{1,2})月")
_REPORT_PERIOD_RE = re.compile(r"报告期[:：]\s*(\d{4})年\s*(\d{1,2})月")
_TR_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S | re.I)
_TD_RE = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")

_NEW_LABEL = "新建商品住宅销售价格指数"
_RESALE_LABEL = "二手住宅销售价格指数"

# 观测指标映射：SourceRecord 字段键 → (metric_code, property_type, 同比字段键)
_METRIC_FIELDS = (
    ("new_house_price_index", "new_build", "new_build_yoy_index"),
    ("second_hand_price_index", "resale", "resale_yoy_index"),
)


@dataclass(frozen=True)
class IndexEntry:
    """列表页条目：发布日期 + 详情页链接 + 期次。"""

    publish_date: str  # YYYY-MM-DD（列表页日期）
    url: str  # 详情页绝对 URL（白名单内）
    title: str
    period_year: int
    period_month: int


def _cell_text(raw: str) -> str:
    return _TAG_RE.sub("", raw).replace("\xa0", " ").strip()


def parse_list_page(html: str) -> list[IndexEntry]:
    """解析栏目列表页 → 条目列表（按页面顺序）。非本期条目/导航链接忽略。"""
    entries: list[IndexEntry] = []
    for li in _LI_RE.findall(html):
        m_date = _DATE_RE.search(li)
        m_href = _HREF_RE.search(li)
        m_title = _TITLE_ATTR_RE.search(li)
        if not (m_date and m_href and m_title):
            continue  # 导航/分页等其它 li
        m_period = _PERIOD_RE.search(m_title.group(1))
        if not m_period:
            continue  # 非「住宅销售价格指数YYYY年M月」条目
        entries.append(
            IndexEntry(
                publish_date=m_date.group(1),
                url=urljoin(LIST_URL, m_href.group(1)),
                title=m_title.group(1).strip(),
                period_year=int(m_period.group(1)),
                period_month=int(m_period.group(2)),
            )
        )
    return entries


def parse_detail_page(html: str, entry: IndexEntry) -> SourceRecord:
    """解析单期详情页表格 → 1 条 SourceRecord（缺表/缺行/不一致 → 稳定异常）。

    结构（对接前手工核对，2026-09 与 2026-08 两期实测一致）：
      报告期：YYYY年M月 | 表头(指标名称/本月/环比) | 新建行 | 二手行 | 注：数据来自国家统计局青岛调查队。
    """
    if not _TR_RE.search(html):
        raise ParseError("详情页无可解析的数据表格结构（页面可能不是期次详情页或已改版）")

    report_year = report_month = 0
    new_vals: tuple[str, str] | None = None
    resale_vals: tuple[str, str] | None = None

    for tr in _TR_RE.findall(html):
        cells = [_cell_text(c) for c in _TD_RE.findall(tr)]
        if not cells:
            continue
        m_report = _REPORT_PERIOD_RE.match(cells[0])
        if m_report:
            report_year, report_month = int(m_report.group(1)), int(m_report.group(2))
        elif cells[0].startswith(_NEW_LABEL) and len(cells) >= 3:
            new_vals = (cells[1], cells[2])
        elif cells[0].startswith(_RESALE_LABEL) and len(cells) >= 3:
            resale_vals = (cells[1], cells[2])

    if report_year == 0 or report_month == 0:
        raise ValidationError("详情页缺少「报告期」行，无法确定统计期次")
    if (report_year, report_month) != (entry.period_year, entry.period_month):
        raise ValidationError(
            f"列表期次（{entry.period_year}年{entry.period_month}月）与"
            f"报告期（{report_year}年{report_month}月）不一致"
        )
    if new_vals is None or resale_vals is None:
        raise ValidationError("详情页缺少新建或二手住宅价格指数数据行")

    def _num(raw: str, label: str) -> float:
        try:
            return float(raw)
        except ValueError:
            raise ValidationError(f"{label} 不是数值：{raw!r}") from None

    stat_date = _month_end(report_year, report_month)
    return SourceRecord(
        source_id=QdStatsIndexConnector.source_code,
        object_type="region",
        object_id=AUTHORIZED_REGION,
        fields={
            "stat_date": stat_date,
            "sample_count": 0,  # 来源不公布样本量，禁止造数
            "report_period": f"{report_year}年{report_month}月",
            "new_build_yoy_index": _num(new_vals[0], "新建商品住宅-本月(上年同月=100)"),
            "new_build_mom_index": _num(new_vals[1], "新建商品住宅-环比(上月=100)"),
            "resale_yoy_index": _num(resale_vals[0], "二手住宅-本月(上年同月=100)"),
            "resale_mom_index": _num(resale_vals[1], "二手住宅-环比(上月=100)"),
            "publish_date": entry.publish_date,
            "source_note": "数据来自国家统计局青岛调查队",
        },
    )


def _month_end(year: int, month: int) -> str:
    """报告月月末（YYYY-MM-DD，月度指数统计日期口径）。"""
    last_day = calendar.monthrange(year, month)[1]
    return date(year, month, last_day).isoformat()


def index_observations(record: SourceRecord) -> list[NormalizedObservation]:
    """每期记录 → 2 条归一化观测（新建/二手各 1，index_value=同比列）。

    环比列不参与归一化观测（price_observations 每（对象,价格类型,指标,统计日）一条，
    双口径落库映射属 TASK-04E）；四值原始字段仍在 record.fields 中保留。
    """
    observations: list[NormalizedObservation] = []
    for metric_code, property_type, yoy_key in _METRIC_FIELDS:
        sub = SourceRecord(
            source_id=record.source_id,
            object_type=record.object_type,
            object_id=record.object_id,
            fields={**record.fields, "index_value": record.fields[yoy_key]},
        )
        observations.append(
            normalize_record(
                sub,
                price_type="official_index",
                metric_code=metric_code,
                connector_version=QdStatsIndexConnector.connector_version,
                property_type=property_type,
            )
        )
    return observations


class QdStatsIndexConnector(SourceConnector):
    """青岛市统计局住宅价格指数连接器（唯一官方已接入源）。"""

    source_code = "qd_stats_price_index"
    allowed_hosts = ("qdtj.qingdao.gov.cn",)
    # 全站 http（https 证书主机名不匹配）——静态例外，白名单子集（核验报告 §1）
    allowed_insecure_hosts = ("qdtj.qingdao.gov.cn",)
    connector_version = "0.1.0"
    supports_community = False  # 无社区级字段/授权

    def health_check(self) -> SourceHealth:
        try:
            _, latency = self.measure_latency_ms(lambda: self.http.get_text(LIST_URL))
        except ConnectorError as exc:
            return SourceHealth(
                status="down", latency_ms=None, detail=f"列表页不可达（{exc.code}）"
            )
        return SourceHealth(status="ok", latency_ms=latency, detail="栏目列表页可达")

    def fetch_region_data(
        self, region_ids: Sequence[str], date_range: tuple[str, str]
    ) -> list[SourceRecord]:
        for rid in region_ids:
            if rid != AUTHORIZED_REGION:
                raise ValidationError(
                    f"超出授权区域范围：{rid}（本源仅授权 {AUTHORIZED_REGION} 市级）"
                )
        start, end = date_range
        if not (start <= end):
            raise ValidationError(f"date_range 非法：{start} > {end}")

        entries = parse_list_page(self.http.get_text(LIST_URL))
        if not entries:
            # 栏目常年有历史期次；解析为 0 条 = 页面结构变化/异常页（不得静默记成功）
            raise ParseError("列表页未解析到任何期次条目（页面可能已改版）")
        selected = [e for e in entries if start <= e.publish_date <= end]
        records: list[SourceRecord] = []
        for entry in selected:
            records.append(
                parse_detail_page(self.http.get_text(entry.url), entry)
            )
        return records

    def fetch_community_data(self, community_ids, date_range):
        # 无社区级授权/字段（核验报告 §3）：返回 unsupported，不伪造
        return UNSUPPORTED
