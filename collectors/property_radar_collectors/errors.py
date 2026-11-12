# TASK-04B：连接器稳定错误体系（PRD §5.6 / 任务行 1290–1294）
# 所有面向任务调度层的异常都必须是 ConnectorError 子类并携带稳定 code，
# 不向调度层抛裸异常；错误消息经 redact 掩码，不携带 secret / 令牌 / 完整个体数据。
from __future__ import annotations

import re

# ---- 日志与错误消息脱敏（PRD §5.6-6：不记录 Cookie/Authorization/OTP/邮箱/访问令牌） ----

_EMAIL_RE = re.compile(r"[\w.+-]+@([\w-]+\.[\w.-]+)")
# 凭据关键词（含 *_SECRET/*_TOKEN 等命名形态）后的键值分隔与取值一律掩码
_BEARER_RE = re.compile(
    r"(?i)(\b\w*(?:bearer|token|secret|password|api[-_]?key)\w*\b)\s*[=: ]\s*\S+"
)
_TOKEN_LIKE_RE = re.compile(r"\b[A-Za-z0-9_-]{24,}\b")  # 长随机串（令牌形态）


def redact(text: str) -> str:
    """掩码邮箱本地部分、凭据关键词后的值与长随机令牌形态。"""
    masked = _EMAIL_RE.sub(lambda m: "***@" + m.group(1), text)
    masked = _BEARER_RE.sub(lambda m: m.group(1) + " ***", masked)
    masked = _TOKEN_LIKE_RE.sub("***", masked)
    return masked


class ConnectorError(Exception):
    """连接器异常基类：稳定 code + 已脱敏 message。"""

    code: str = "connector_error"

    def __init__(self, message: str, *, code: str | None = None):
        if code:
            self.code = code
        self.message = redact(message)
        super().__init__(self.message)


class AllowlistViolation(ConnectorError):
    """非白名单 / 非 https / 带凭据 URL——任何网络 I/O 之前抛出。"""

    code = "allowlist_violation"


class RateLimited(ConnectorError):
    """超过本连接器速率限制（请求间隔 / 并发上限）。"""

    code = "rate_limited"


class TimeoutExceeded(ConnectorError):
    """连接或读取超时且重试用尽。"""

    code = "timeout_exceeded"


class RetriesExhausted(ConnectorError):
    """瞬时错误（5xx / 传输失败）重试用尽。"""

    code = "retries_exhausted"


class ResponseTooLarge(ConnectorError):
    """响应体超过字节上限，读取中止。"""

    code = "response_too_large"


class HttpStatusError(ConnectorError):
    """非 2xx 响应（不回显响应体内容）。"""

    code = "http_status_error"

    def __init__(self, message: str, *, status: int):
        self.status = status
        super().__init__(message)


class ParseError(ConnectorError):
    """响应体不是合法 JSON / 解析失败。"""

    code = "parse_error"


class ValidationError(ConnectorError):
    """归一化输入不合法（缺必填、日期形态、极端价格、负样本量等）。"""

    code = "validation_error"


class NotApprovedError(ConnectorError):
    """来源未获批准 / 超出授权覆盖——连接器禁止运行（04B 验收二）。"""

    code = "not_approved"


class InternalUnavailable(ConnectorError):
    """internal API 不可用（未配置密钥、签名链被拒、网络失败）。"""

    code = "internal_unavailable"
