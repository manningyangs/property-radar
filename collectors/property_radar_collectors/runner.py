# TASK-04B：运行前置门禁（PRD 04B 验收二「不能设置 approved 的连接器无法运行」/
# §11.1-2「来源状态不是 approved_open/approved_licensed 立即跳过」）
# 判定完全经 /internal/sources/:id/eligibility 走服务端 source-gate——
# Python 侧不直查数据库（project_memory 红线：connector 复用 source-gate 门禁）。
from __future__ import annotations

from typing import Any

from .errors import NotApprovedError
from .internal_client import InternalApiClient


def run_guard(
    client: InternalApiClient,
    source_id: str,
    city_code: str,
    object_level: str,
) -> dict[str, Any]:
    """连接器运行前必须调用：资格通过才允许进入采集流程。

    @raise NotApprovedError: 来源未批准 / 超出授权覆盖 / 来源不存在（not_approved）。
    @return: 服务端资格结论 {eligible, source_id, status, valid_until}。
    """
    # 服务端 403（source_not_approved/city_coverage_denied）/404（source_not_found）
    # 均已映射为 NotApprovedError；此处只兜底 eligible=false 的异常形态。
    result = client.check_eligibility(source_id, city_code, object_level)
    if not result.get("eligible"):
        raise NotApprovedError(
            f"来源未获自动采集许可（status={result.get('status', 'unknown')}）"
        )
    return result
