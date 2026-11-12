# TASK-04B：Worker internal API 签名客户端（PRD §10.4：HMAC 签名、时间戳、nonce、防重放）
# 与服务端 apps/api/src/routes/internal.ts 完全同口径：
#   X-Ingest-Signature = HMAC-SHA256(secret, `${timestamp}.${nonce}.${rawBody}`) 小写 hex
# secret 只从构造参数或环境变量 INGEST_HMAC_SECRET 读取，绝不入日志/异常消息。
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any, Mapping

import httpx

from .errors import InternalUnavailable, NotApprovedError, redact

DEFAULT_TIMEOUT_SECONDS = 10.0

# 服务端稳定错误码 → 连接器侧语义（未批准/超范围/来源不存在 = 禁止运行）
_GATE_ERROR_CODES = frozenset(
    {"source_not_approved", "city_coverage_denied", "source_not_found"}
)


class InternalApiClient:
    """对 /api/v1/internal/* 的 HMAC 签名客户端。"""

    def __init__(
        self,
        base_url: str,
        secret: str | None = None,
        transport: httpx.BaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ):
        self.base_url = base_url.rstrip("/")
        if secret is None:
            secret = os.environ.get("INGEST_HMAC_SECRET", "").strip()
        self._secret = secret
        self._client = httpx.Client(
            timeout=timeout, transport=transport, follow_redirects=False
        )

    def close(self) -> None:
        self._client.close()

    @staticmethod
    def sign(secret: str, timestamp: str, nonce: str, raw_body: str) -> str:
        """HMAC-SHA256 → 小写 hex（独立可对拍的签名口径）。"""
        message = f"{timestamp}.{nonce}.{raw_body}"
        return hmac.new(
            secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def _post(self, path: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        if not self._secret:
            # 密钥缺失：端点整体禁用（服务端同语义 403 ingest_disabled）
            raise InternalUnavailable("INGEST_HMAC_SECRET 未配置，internal 端点禁用")

        raw_body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        timestamp = str(int(time.time()))
        nonce = secrets.token_urlsafe(16)
        headers = {
            "Content-Type": "application/json",
            "X-Ingest-Timestamp": timestamp,
            "X-Ingest-Nonce": nonce,
            "X-Ingest-Signature": self.sign(self._secret, timestamp, nonce, raw_body),
        }
        try:
            resp = self._client.post(
                f"{self.base_url}{path}", content=raw_body, headers=headers
            )
        except httpx.HTTPError as exc:
            raise InternalUnavailable(
                f"internal API 请求失败（{type(exc).__name__}）"
            ) from None

        if 200 <= resp.status_code < 300:
            try:
                return resp.json()
            except ValueError:
                raise InternalUnavailable("internal API 返回非 JSON 响应") from None

        # 错误路径：只取稳定 error_code 与服务端已脱敏 message
        error_code = ""
        server_message = ""
        try:
            body = resp.json()
            error_code = str(body.get("error_code", ""))
            server_message = redact(str(body.get("message", "")))
        except ValueError:
            pass
        detail = f"{error_code}: {server_message}" if error_code else f"HTTP {resp.status_code}"
        if error_code in _GATE_ERROR_CODES:
            raise NotApprovedError(f"来源资格校验未通过（{detail}）")
        raise InternalUnavailable(f"internal API 拒绝请求（{detail}）")

    # ---- §10.4 四类端点 ----

    def check_eligibility(
        self,
        source_id: str,
        city_code: str | None = None,
        object_level: str | None = None,
    ) -> dict[str, Any]:
        """运行前资格预检；403/404 → NotApprovedError（not_approved）。"""
        if (city_code is None) != (object_level is None):
            raise ValueError("city_code 与 object_level 必须同时提供")
        payload: dict[str, Any] = {}
        if city_code is not None and object_level is not None:
            payload = {"city_code": city_code, "object_level": object_level}
        return self._post(f"/internal/sources/{source_id}/eligibility", payload)

    def submit_batch(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """提交签名数据批次（门禁兜底仍生效）。"""
        return self._post("/internal/ingest/batch", payload)

    def job_start(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """记录任务开始（服务端先过 source-gate 门禁）。"""
        return self._post("/internal/jobs/start", payload)

    def job_finish(
        self,
        job_id: str,
        status: str,
        error_code: str | None = None,
        note: str | None = None,
    ) -> dict[str, Any]:
        """记录任务完成（幂等；未知 job 服务端 404）。"""
        payload: dict[str, Any] = {"status": status}
        if error_code is not None:
            payload["error_code"] = error_code
        if note is not None:
            payload["note"] = note
        return self._post(f"/internal/jobs/{job_id}/finish", payload)

    def report_health(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        """上报来源健康状态（服务端不设资格门禁，down 也可记录）。"""
        return self._post("/internal/health/source", payload)
