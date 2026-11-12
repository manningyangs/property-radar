# TASK-04B：归一化 Schema（PRD 任务行 1290 / §9.1 price_observations 字段对齐 / §5.7 不存原始 HTML）
# SourceRecord  = 连接器解析出的来源原始记录最小字段（仅必要业务字段，无 HTML/图片/个人信息）
# NormalizedObservation = 统一单位、日期、口径和来源标识后的标准化观测
# 本模块纯函数、无任何数据库写入（清洗/去重/落库属 TASK-04E）。
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Mapping

from .errors import ValidationError

# ---- 枚举（与 Public DB CHECK / PRD §9.1 口径一致） ----
OBJECT_TYPES = ("region", "community", "listing")
PROPERTY_TYPES = ("new_build", "resale")
PRICE_TYPES = (
    "listing_ask",
    "closed_transaction",
    "official_index",
    "user_reported",
    "model_estimate",
)
QUALITY_STATUSES = ("valid", "low_sample", "stale", "outlier", "rejected")

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# 极端价格护栏（分）：>1000 万元/套 或 单价 >10 万元/㎡ 视为异常输入拒绝归一化
_MAX_TOTAL_FEN = 1_000_000_000
_MAX_UNIT_YUAN = 100_000


@dataclass(frozen=True)
class SourceRecord:
    """来源原始记录最小字段（解析产物，不含原始 HTML/图片/联系方式）。"""

    source_id: str
    object_type: str
    object_id: str
    fields: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizedObservation:
    """标准化观测（字段名对齐 §9.1 price_observations）。"""

    source_id: str
    object_type: str
    object_id: str
    property_type: str
    price_type: str
    metric_code: str
    price_total_fen: int | None
    unit_price_yuan_sqm: int | None
    area_sqm: float | None
    sample_count: int
    stat_date: str
    quality_status: str
    connector_version: str


def _require(cond: bool, message: str) -> None:
    if not cond:
        raise ValidationError(message)


def normalize_record(
    record: SourceRecord,
    *,
    price_type: str,
    metric_code: str,
    connector_version: str,
    property_type: str = "resale",
    quality_status: str = "valid",
) -> NormalizedObservation:
    """把来源记录归一化为 NormalizedObservation（严格校验，失败抛稳定 code）。

    record.fields 约定键：
      stat_date (YYYY-MM-DD, 必填)、sample_count (int ≥0, 必填)、
      total_price_yuan (数, 可选)、unit_price_yuan_sqm (数, 可选)、area_sqm (数, 可选)。
    total_price_yuan 与 unit_price_yuan_sqm 至少一个必填。
    """
    _require(record.object_type in OBJECT_TYPES, f"object_type 非法：{record.object_type}")
    _require(price_type in PRICE_TYPES, f"price_type 非法：{price_type}")
    _require(property_type in PROPERTY_TYPES, f"property_type 非法：{property_type}")
    _require(
        quality_status in QUALITY_STATUSES,
        f"quality_status 非法：{quality_status}",
    )
    _require(bool(record.object_id), "object_id 不能为空")
    _require(bool(metric_code), "metric_code 不能为空")

    f = record.fields
    # 统计日期：形态 YYYY-MM-DD（不做时区换算，口径版本化属 04E）
    stat_date = f.get("stat_date")
    _require(
        isinstance(stat_date, str) and bool(_DATE_RE.match(stat_date)),
        f"stat_date 必须是 YYYY-MM-DD 形态，收到：{stat_date!r}",
    )

    # 样本量：必填整数且非负
    sample_count = f.get("sample_count")
    _require(
        isinstance(sample_count, int) and not isinstance(sample_count, bool),
        f"sample_count 必须是整数，收到：{sample_count!r}",
    )
    _require(sample_count >= 0, f"sample_count 不得为负，收到：{sample_count}")

    # 价格：元 → 分（总价），单价保持元/㎡；至少一项；拒绝极端值
    raw_total = f.get("total_price_yuan")
    raw_unit = f.get("unit_price_yuan_sqm")
    _require(
        raw_total is not None or raw_unit is not None,
        "total_price_yuan 与 unit_price_yuan_sqm 至少提供一项",
    )

    price_total_fen: int | None = None
    if raw_total is not None:
        _require(
            isinstance(raw_total, (int, float)) and not isinstance(raw_total, bool),
            f"total_price_yuan 必须是数值，收到：{raw_total!r}",
        )
        _require(raw_total > 0, f"total_price_yuan 必须为正，收到：{raw_total}")
        price_total_fen = int(round(raw_total * 100))
        _require(
            price_total_fen <= _MAX_TOTAL_FEN,
            f"total_price_yuan 超出合理区间（极端价格）：{raw_total}",
        )

    unit_price_yuan_sqm: int | None = None
    if raw_unit is not None:
        _require(
            isinstance(raw_unit, (int, float)) and not isinstance(raw_unit, bool),
            f"unit_price_yuan_sqm 必须是数值，收到：{raw_unit!r}",
        )
        _require(raw_unit > 0, f"unit_price_yuan_sqm 必须为正，收到：{raw_unit}")
        _require(
            raw_unit <= _MAX_UNIT_YUAN,
            f"unit_price_yuan_sqm 超出合理区间（极端价格）：{raw_unit}",
        )
        unit_price_yuan_sqm = int(round(raw_unit))

    area_raw = f.get("area_sqm")
    area_sqm: float | None = None
    if area_raw is not None:
        _require(
            isinstance(area_raw, (int, float)) and not isinstance(area_raw, bool),
            f"area_sqm 必须是数值，收到：{area_raw!r}",
        )
        _require(area_raw > 0, f"area_sqm 必须为正，收到：{area_raw}")
        area_sqm = float(area_raw)

    return NormalizedObservation(
        source_id=record.source_id,
        object_type=record.object_type,
        object_id=record.object_id,
        property_type=property_type,
        price_type=price_type,
        metric_code=metric_code,
        price_total_fen=price_total_fen,
        unit_price_yuan_sqm=unit_price_yuan_sqm,
        area_sqm=area_sqm,
        sample_count=sample_count,
        stat_date=stat_date,
        quality_status=quality_status,
        connector_version=connector_version,
    )
