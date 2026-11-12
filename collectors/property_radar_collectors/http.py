# TASK-04B：安全 HTTP 层（PRD §5.6：allowlist → 速率限制 → 超时 → 重试 → 响应体上限 → 日志脱敏）
# 约束：
#   - 仅 GET；任何请求前先过 allowlist（零网络 I/O 前拒绝任意 URL）；
#   - 连接/读取超时、有限重试 + 指数退避（仅 5xx/超时/传输错误，4xx 不重试）；
#   - 最小请求间隔 + 并发上限；流式读取响应体超过字节上限立即中止；
#   - 非 2xx → HttpStatusError（不回显响应体）；3xx 不跟随（防跳转绕过白名单）；
#   - 日志只记 method/host/path/status/耗时/字节数——绝不记请求头、令牌、query、响应体。
from __future__ import annotations

import json
import logging
import threading
import time
from dataclasses import dataclass
from typing import Any, Mapping

import httpx

from .allowlist import assert_url_allowed
from .errors import (
    HttpStatusError,
    ParseError,
    ResponseTooLarge,
    RetriesExhausted,
    TimeoutExceeded,
)

logger = logging.getLogger("property_radar_collectors.http")


@dataclass(frozen=True)
class SafeHttpConfig:
    """安全 HTTP 层可调参数（默认值面向低频官方端点采集）。"""

    connect_timeout: float = 5.0
    read_timeout: float = 10.0
    max_retries: int = 2
    backoff_base_seconds: float = 0.2
    min_request_interval: float = 1.0
    max_concurrency: int = 2
    max_response_bytes: int = 2_000_000
    user_agent: str = "property-radar-collector/0.1"


class _Retryable(Exception):
    """内部瞬时错误标记（不对外暴露）。kind: timeout | server | transport"""

    def __init__(self, kind: str):
        self.kind = kind


class SafeHttpClient:
    """带白名单与各项安全约束的 GET 客户端（JSON / 文本）。"""

    def __init__(
        self,
        allowed_hosts: tuple[str, ...] | list[str],
        config: SafeHttpConfig | None = None,
        transport: httpx.BaseTransport | None = None,
        allow_http_hosts: tuple[str, ...] | list[str] = (),
    ):
        self.config = config or SafeHttpConfig()
        self.allowed_hosts = tuple(allowed_hosts)
        # TASK-04C：显式声明才允许明文 http 的主机（静态常量，白名单子集）
        self.allow_http_hosts = tuple(allow_http_hosts)
        self._client = httpx.Client(
            timeout=httpx.Timeout(
                self.config.connect_timeout, read=self.config.read_timeout
            ),
            transport=transport,
            follow_redirects=False,
        )
        self._sem = threading.BoundedSemaphore(self.config.max_concurrency)
        self._throttle_lock = threading.Lock()
        self._last_request_at = 0.0

    def close(self) -> None:
        self._client.close()

    # ---- 速率限制：最小请求间隔（锁内等待，序列化节拍） ----
    def _throttle(self) -> None:
        with self._throttle_lock:
            now = time.monotonic()
            wait = self._last_request_at + self.config.min_request_interval - now
            if wait > 0:
                time.sleep(wait)
                now = time.monotonic()
            self._last_request_at = now

    def _log(self, url: str, status: int | None, elapsed_ms: float, size: int | None, note: str = "") -> None:
        parts = httpx.URL(url)
        target = f"{parts.scheme}://{parts.host}{parts.path}"
        logger.info(
            "GET %s -> %s (%.0fms%s%s)",
            target,
            status if status is not None else "ERR",
            elapsed_ms,
            f", {size} bytes" if size is not None else "",
            f", {note}" if note else "",
        )

    def get_json(self, url: str, headers: Mapping[str, str] | None = None) -> Any:
        """按白名单安全地 GET 一个 JSON 端点。

        @raise AllowlistViolation/RateLimited/TimeoutExceeded/RetriesExhausted/
                ResponseTooLarge/HttpStatusError/ParseError: 携带稳定 code。
        """
        buf = self._get_bytes(url, headers)
        try:
            return json.loads(bytes(buf))
        except (ValueError, UnicodeDecodeError) as exc:
            raise ParseError(
                f"响应体不是合法 JSON（{type(exc).__name__}）"
            ) from None

    def get_text(self, url: str, headers: Mapping[str, str] | None = None) -> str:
        """按白名单安全地 GET 一个文本/HTML 端点（解析用，不落盘，PRD §5.7）。

        编码：先 utf-8，失败回退 gb18030（政府站点常见），再失败抛 ParseError。
        """
        buf = bytes(self._get_bytes(url, headers))
        for enc in ("utf-8", "gb18030"):
            try:
                return buf.decode(enc)
            except UnicodeDecodeError:
                continue
        raise ParseError("响应体不是可识别的文本编码（utf-8/gb18030 均失败）")

    def _get_bytes(self, url: str, headers: Mapping[str, str] | None) -> bytes:
        # 白名单校验在任何网络 I/O 之前（04B 验收一；04C http 例外仍为静态声明）
        assert_url_allowed(url, self.allowed_hosts, allow_http_hosts=self.allow_http_hosts)

        attempts = self.config.max_retries + 1
        for attempt in range(attempts):
            self._throttle()
            try:
                return self._attempt_get(url, headers)
            except _Retryable as exc:
                if attempt + 1 >= attempts:
                    if exc.kind == "timeout":
                        raise TimeoutExceeded(
                            f"请求超时且重试用尽（{attempts} 次）"
                        ) from None
                    raise RetriesExhausted(
                        f"上游持续失败，重试用尽（{attempts} 次）"
                    ) from None
                time.sleep(self.config.backoff_base_seconds * (2**attempt))
        raise RetriesExhausted("重试逻辑异常退出")  # pragma: no cover

    def _attempt_get(
        self, url: str, headers: Mapping[str, str] | None
    ) -> bytes:
        with self._sem:
            started = time.monotonic()
            try:
                with self._client.stream("GET", url, headers=headers) as resp:
                    elapsed_ms = (time.monotonic() - started) * 1000
                    status = resp.status_code
                    # 5xx：瞬时错误，交给上层退避重试（不回显响应体）
                    if status >= 500:
                        self._log(url, status, elapsed_ms, None, "retryable")
                        raise _Retryable("server")
                    # 其余非 2xx（含 3xx 不跟随）：稳定错误，不重试
                    if not 200 <= status < 300:
                        self._log(url, status, elapsed_ms, None)
                        raise HttpStatusError(
                            f"上游响应 HTTP {status}（不回显响应体）", status=status
                        )
                    # 流式读取 + 字节上限
                    buf = bytearray()
                    for chunk in resp.iter_bytes():
                        buf += chunk
                        if len(buf) > self.config.max_response_bytes:
                            self._log(
                                url, status, elapsed_ms, None, "too_large"
                            )
                            raise ResponseTooLarge(
                                f"响应体超过上限 {self.config.max_response_bytes} 字节，已中止读取"
                            )
                    self._log(url, status, elapsed_ms, len(buf))
                    return bytes(buf)
            except _Retryable:
                raise
            except (HttpStatusError, ResponseTooLarge, ParseError):
                raise
            except httpx.TimeoutException:
                elapsed_ms = (time.monotonic() - started) * 1000
                self._log(url, None, elapsed_ms, None, "timeout")
                raise _Retryable("timeout") from None
            except httpx.TransportError:
                elapsed_ms = (time.monotonic() - started) * 1000
                self._log(url, None, elapsed_ms, None, "transport_error")
                raise _Retryable("transport") from None
