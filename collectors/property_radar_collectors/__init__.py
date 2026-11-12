# TASK-04B：房价雷达 Python 连接器框架（PRD 任务行 1288–1294 / §5.6 连接器规范）
# TASK-04C：首个官方数据源——青岛市统计局住宅价格指数连接器（qd_stats_price_index）。
# 该来源已通过公开核验（docs/TASK-04C 核验报告）并取得 approved_open 许可状态；
# 全站仅 http（证书主机名不匹配），通过 allowed_insecure_hosts 静态声明的
# 白名单子集例外放行明文 http，其余连接器仍强制 https、fail closed。
from .allowlist import assert_url_allowed
from .connector import (
    HEALTH_STATUSES,
    UNSUPPORTED,
    SourceConnector,
    SourceHealth,
)
from .errors import (
    AllowlistViolation,
    ConnectorError,
    HttpStatusError,
    InternalUnavailable,
    NotApprovedError,
    ParseError,
    RateLimited,
    ResponseTooLarge,
    RetriesExhausted,
    TimeoutExceeded,
    ValidationError,
    redact,
)
from .http import SafeHttpClient, SafeHttpConfig
from .internal_client import InternalApiClient
from .qingdao_index import (
    LIST_URL,
    IndexEntry,
    QdStatsIndexConnector,
    index_observations,
    parse_detail_page,
    parse_list_page,
)
from .runner import run_guard
from .schema import (
    NormalizedObservation,
    SourceRecord,
    normalize_record,
)

__version__ = "0.3.0"

__all__ = [
    "AllowlistViolation",
    "ConnectorError",
    "HEALTH_STATUSES",
    "HttpStatusError",
    "IndexEntry",
    "InternalApiClient",
    "InternalUnavailable",
    "LIST_URL",
    "NotApprovedError",
    "NormalizedObservation",
    "ParseError",
    "QdStatsIndexConnector",
    "RateLimited",
    "ResponseTooLarge",
    "RetriesExhausted",
    "SafeHttpClient",
    "SafeHttpConfig",
    "SourceConnector",
    "SourceHealth",
    "SourceRecord",
    "UNSUPPORTED",
    "TimeoutExceeded",
    "ValidationError",
    "assert_url_allowed",
    "index_observations",
    "normalize_record",
    "parse_detail_page",
    "parse_list_page",
    "redact",
    "run_guard",
]
