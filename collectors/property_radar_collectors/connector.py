# TASK-04B：统一连接器接口（PRD §5.6 SourceConnector 四方法）
#   health_check        —— 检查官方端点是否可用（不绕过访问控制）
#   fetch_region_data   —— 仅访问授权范围内的数据
#   fetch_community_data—— 无社区级授权/字段时返回 unsupported，不伪造数据
#   normalize           —— 统一单位、日期、口径和来源标识
# 所有网络访问必须经 SafeHttpClient（allowlist/超时/限速/上限）；
# 运行前资格预检由 runner.run_guard 完成（未 approved 不得运行）。
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import ClassVar, Sequence

from .http import SafeHttpClient
from .schema import NormalizedObservation, SourceRecord, normalize_record

# fetch_community_data 的「不支持」返回值（PRD §5.6：返回 unsupported，不伪造数据）
UNSUPPORTED = "unsupported"

# 健康状态取值（上报 /internal/health/source 的同一口径）
HEALTH_STATUSES = ("ok", "degraded", "down")


@dataclass(frozen=True)
class SourceHealth:
    """来源健康检查结果。"""

    status: str  # ok | degraded | down
    latency_ms: int | None = None
    detail: str | None = None

    def __post_init__(self) -> None:
        if self.status not in HEALTH_STATUSES:
            raise ValueError(f"非法健康状态：{self.status}")


class SourceConnector(ABC):
    """连接器基类：静态白名单 + 归一化版本 + 安全 HTTP 客户端。"""

    #: 来源编码（与 data_sources_public.source_id 一致）
    source_code: ClassVar[str]
    #: 静态域名白名单（代码常量，运行时不可注入任意目标）
    allowed_hosts: ClassVar[tuple[str, ...]] = ()
    #: 连接器解析器版本（写入 NormalizedObservation.connector_version）
    connector_version: ClassVar[str] = "0.0.0"
    #: 是否具备社区级授权/字段（False 时 fetch_community_data 返回 unsupported）
    supports_community: ClassVar[bool] = False
    #: TASK-04C：显式声明才允许明文 http 的主机（须为 allowed_hosts 子集，静态常量）
    allowed_insecure_hosts: ClassVar[tuple[str, ...]] = ()

    def __init__(self, http: SafeHttpClient | None = None):
        # 兜底：即使调用方忘记注入，也只允许该连接器白名单内的主机；
        # http 例外仅限 allowed_insecure_hosts 静态声明（仍为白名单子集，fail closed）
        self.http = http or SafeHttpClient(
            self.allowed_hosts,
            allow_http_hosts=self.allowed_insecure_hosts,
        )

    @abstractmethod
    def health_check(self) -> SourceHealth:
        """检查官方端点是否可用，只走白名单与安全 HTTP 层。"""

    @abstractmethod
    def fetch_region_data(
        self, region_ids: Sequence[str], date_range: tuple[str, str]
    ) -> list[SourceRecord]:
        """仅访问授权范围内的数据；授权外数据不抓取。"""

    def fetch_community_data(
        self, community_ids: Sequence[str], date_range: tuple[str, str]
    ) -> list[SourceRecord] | str:
        """无社区级授权/字段时返回 unsupported，不伪造数据。"""
        if not self.supports_community:
            return UNSUPPORTED
        return self._fetch_community_data(community_ids, date_range)

    def _fetch_community_data(
        self, community_ids: Sequence[str], date_range: tuple[str, str]
    ) -> list[SourceRecord]:
        """子类在 supports_community=True 时必须实现。"""
        raise NotImplementedError(
            f"{type(self).__name__} 声明支持社区级数据但未实现 _fetch_community_data"
        )

    def normalize(self, record: SourceRecord, *, price_type: str, metric_code: str) -> NormalizedObservation:
        """统一单位、日期、口径和来源标识（§5.6 四方法之一）。"""
        return normalize_record(
            record,
            price_type=price_type,
            metric_code=metric_code,
            connector_version=self.connector_version,
        )

    # ---- 便捷测量：记录耗时（不含任何头/令牌） ----
    @staticmethod
    def measure_latency_ms(fn) -> tuple[object, int]:
        started = time.monotonic()
        result = fn()
        return result, int((time.monotonic() - started) * 1000)
