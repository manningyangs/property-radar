# TASK-04B：房价雷达 Python 连接器框架（PRD 任务行 1288–1294 / §5.6 连接器规范）
# 合规状态：当前无 approved 级别的可自动采集数据源，本包不包含任何站点爬虫；
# 本模块只提供框架：域名白名单、安全 HTTP、归一化 Schema、错误与健康状态、
# internal 签名客户端与运行前置门禁。首个真实连接器在取得书面授权后的 04C 任务实施。
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
from .runner import run_guard
from .schema import (
    NormalizedObservation,
    SourceRecord,
    normalize_record,
)

__version__ = "0.2.0"

__all__ = [
    "AllowlistViolation",
    "ConnectorError",
    "HEALTH_STATUSES",
    "HttpStatusError",
    "InternalApiClient",
    "InternalUnavailable",
    "NotApprovedError",
    "NormalizedObservation",
    "ParseError",
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
    "normalize_record",
    "redact",
    "run_guard",
]
