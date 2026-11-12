# TASK-04D：房天下（fang_com）小区挂牌列表连接器（spec R5 / PRD 任务行 1304–1310）
# 负责人 2026-11-12 裁决（spec §0-1，替代 PRD 行 1308 旧表述）：
#   仅用于首批开通城市 10–20 个小区真实挂牌/成交数据的验证管线——公开挂牌页轻量爬取，
#   仍守住：不绕过验证码/登录/访问控制、不碰贝壳/链家、不存原始 HTML、不入定时任务（cron）。
# 约束（全部静态/结构化强制，非约定）：
#   - allowlist 三主机全 https（qd.esf.fang.com / m.fang.com / esf.fang.com）；
#   - 每小区仅抓列表首页，最多解析 30 套；每套 → 一条 price_observations 观测（object_type=community）；
#   - 限速 ≥1s/请求（SafeHttpClient 默认 min_request_interval=1.0，不传 config 即生效）；
#   - 站点返回 JS 访问挑战页时如实报告 down / 0 样本，绝不伪造解析（不绕过访问控制）；
#   - 解析产物只留业务字段（总价/单价/面积/套数），不保存原始 HTML。
from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Any, ClassVar, Mapping, Sequence

from .connector import SourceConnector, SourceHealth
from .errors import ConnectorError, ParseError, redact
from .schema import SourceRecord

#: 来源编码（与 data_sources_public.source_id 一致）
SOURCE_ID = "fang_com"
#: 首批开通城市（青岛）与小区级覆盖
CITY_CODE = "370200"
OBJECT_LEVEL = "community"
#: 连接器版本（写入 connector_version，随解析口径演进）
CONNECTOR_VERSION = "fang_community/0.1.0"
#: 每小区列表首页最多取的套数（spec R5 上限）
MAX_LISTINGS_PER_COMMUNITY = 30

#: 房天下挂牌列表页配置（16 个 00B 核验小区 → loupan 列表页 URL）
DEFAULT_CONFIG_PATH = (
    Path(__file__).resolve().parents[2]
    / "config"
    / "cities"
    / "qingdao-community-listings.json"
)

#: 站点 JS 访问挑战页特征（只识别、不绕过）
_CHALLENGE_MARKERS = ("__jsl_clearance_s", "location.href=location.pathname")

#: 列表卡片切分（房天下 PC 列表页每个房源一个 <dl> 块）
_CARD_RE = re.compile(r"<dl[^>]*>.*?</dl>", re.S | re.I)
#: 标签去除（价格数字常被 <span> 等标签拆开）
_TAG_RE = re.compile(r"<[^>]+>")
_TOTAL_RE = re.compile(r"([\d.]+)\s*万")
_UNIT_RE = re.compile(r"([\d,.]+)\s*元/(?:平|㎡|平米)")
_AREA_RE = re.compile(r"([\d.]+)\s*(?:平米|平方米)")
_LOUPAN_ID_RE = re.compile(r"/loupan/(\d+)")


def is_challenge_page(html: str) -> bool:
    """识别站点访问挑战页（JS set-cookie 门）。命中只如实上报，不绕过。"""
    return any(marker in html for marker in _CHALLENGE_MARKERS)


def parse_listing_cards(html: str) -> list[dict[str, Any]]:
    """从列表首页 HTML 解析房源卡片（纯函数；不保留 HTML 片段，只留业务字段）。

    房天下价格常被 <span> 拆开（如 <span>320</span>万），故先去标签再抽数值。
    每张卡片至少有总价（X万）或单价（X元/平）之一，否则跳过（广告/引导位）。
    返回字段键：total_price_yuan（元）、unit_price_yuan_sqm（元/㎡）、
    area_sqm（㎡）、loupan_id（页面链接溯源用，不入库）。
    """
    out: list[dict[str, Any]] = []
    for block in _CARD_RE.findall(html):
        id_m = _LOUPAN_ID_RE.search(block)
        text = _TAG_RE.sub(" ", block)
        if "广告" in text:
            continue
        total_m = _TOTAL_RE.search(text)
        unit_m = _UNIT_RE.search(text)
        if total_m is None and unit_m is None:
            continue
        fields: dict[str, Any] = {}
        if total_m is not None:
            fields["total_price_yuan"] = float(total_m.group(1)) * 10000.0
        if unit_m is not None:
            fields["unit_price_yuan_sqm"] = float(unit_m.group(1).replace(",", ""))
        area_m = _AREA_RE.search(text)
        if area_m is not None:
            fields["area_sqm"] = float(area_m.group(1))
        if id_m is not None:
            fields["loupan_id"] = id_m.group(1)
        out.append(fields)
    return out[:MAX_LISTINGS_PER_COMMUNITY]


def load_communities(config_path: str | Path | None = None) -> list[dict[str, Any]]:
    """加载小区→列表页 URL 映射（只读配置文件；null URL 小区照常返回，由调用方判跳过）。"""
    path = Path(config_path) if config_path is not None else DEFAULT_CONFIG_PATH
    data = json.loads(path.read_text(encoding="utf-8"))
    communities = data.get("communities")
    if not isinstance(communities, list):
        raise ParseError(f"配置缺少 communities 数组：{path}")
    return communities


class FangCommunityConnector(SourceConnector):
    """房天下青岛小区挂牌列表连接器（验证管线专用，不入 cron）。"""

    source_code: ClassVar[str] = SOURCE_ID
    #: 静态域名白名单（全 https，fail closed；不含贝壳/链家——裁决红线）
    allowed_hosts: ClassVar[tuple[str, ...]] = (
        "qd.esf.fang.com",
        "m.fang.com",
        "esf.fang.com",
    )
    allowed_insecure_hosts: ClassVar[tuple[str, ...]] = ()
    connector_version: ClassVar[str] = CONNECTOR_VERSION
    supports_community: ClassVar[bool] = True

    def health_check(self) -> SourceHealth:
        """GET 配置中首个挂牌列表页测延迟（spec R5；经 SafeHttp 白名单）。

        挑战页/异常短内容如实降级，不绕过访问控制。
        """
        try:
            url = self._first_listing_url()
        except (ConnectorError, OSError, ValueError) as exc:
            return SourceHealth(status="down", detail=redact(str(exc))[:160])
        try:
            started = time.monotonic()
            html = self.http.get_text(url)
            latency_ms = int((time.monotonic() - started) * 1000)
        except Exception as exc:  # noqa: BLE001 —— 统一降级为健康状态，不向调度层抛裸异常
            if hasattr(exc, "code"):
                return SourceHealth(
                    status="down",
                    detail=redact(f"{getattr(exc, 'code')}: {exc}")[:160],
                )
            return SourceHealth(status="down", detail=redact(str(exc))[:160])

        if is_challenge_page(html):
            return SourceHealth(
                status="down",
                latency_ms=latency_ms,
                detail="站点返回访问挑战页（识别但不绕过访问控制）",
            )
        if "<title" not in html.lower() or len(html) < 200:
            return SourceHealth(
                status="degraded",
                latency_ms=latency_ms,
                detail="列表页响应内容异常（短响应或缺 title）",
            )
        return SourceHealth(status="ok", latency_ms=latency_ms)

    def _first_listing_url(self) -> str:
        """配置中第一条有列表页 URL 的小区（health 探测目标）。"""
        for community in load_communities():
            url = community.get("listing_url")
            if url:
                return str(url)
        raise ParseError("配置中没有任何小区列表页 URL")

    def fetch_region_data(
        self, region_ids: Sequence[str], date_range: tuple[str, str]
    ) -> list[SourceRecord]:
        """04D 仅提供小区级列表页采集；城市级汇总页未授权，返回空不伪造。"""
        return []

    def _fetch_community_data(
        self, community_ids: Sequence[str], date_range: tuple[str, str]
    ) -> list[SourceRecord]:
        """04B 社区级接口的首次真实实现（spec R5）：逐小区 GET 列表首页解析房源卡片。

        - 无 listing_url 的小区：跳过并返回空（调用方计入未覆盖，零请求）；
        - 未知 community_id：配置无此对象，抛 ParseError 不伪造；
        - stat_date = date_range 结束日（CLI 传 run_date）。
        """
        fetch_date = date_range[1] or date_range[0]
        config = {str(c.get("community_id")): c for c in load_communities()}
        records: list[SourceRecord] = []
        for community_id in community_ids:
            entry = config.get(str(community_id))
            if entry is None:
                raise ParseError(f"配置中不存在小区：{community_id}")
            # 无 URL 小区：fetch_community_listings 内部零请求返回空
            records.extend(self.fetch_community_listings(entry, fetch_date))
        return records

    def fetch_community_listings(
        self, community: Mapping[str, Any], fetch_date: str
    ) -> list[SourceRecord]:
        """抓取单个小区挂牌列表首页 → 每套一条 SourceRecord（object_type=community）。

        @raise ParseError: 挑战页或响应不可解析（0 样本如实上报，不伪造）。
        """
        url = community.get("listing_url")
        if not url:
            # 无 URL 小区：零请求跳过（调用方已在配置层过滤，此处兜底）
            return []
        html = self.http.get_text(str(url))
        if is_challenge_page(html):
            raise ParseError(
                f"站点返回访问挑战页，不绕过（community_id={community.get('community_id')}）"
            )
        records: list[SourceRecord] = []
        for fields in parse_listing_cards(html):
            record_fields: dict[str, Any] = {
                "stat_date": fetch_date,
                "sample_count": 1,  # 每套一条观测，样本量 1（聚合口径在服务端）
                **fields,
            }
            records.append(
                SourceRecord(
                    source_id=self.source_code,
                    object_type="community",
                    object_id=str(community.get("community_id", "")),
                    fields=record_fields,
                )
            )
        return records
