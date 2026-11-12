# TASK-04B：域名静态白名单（PRD §5.6-1：有静态 allowlist 域名，不接受任意 URL 直连）
# 校验必须发生在任何网络 I/O 之前；白名单只来源于代码/配置常量，
# 不提供运行时注入任意 URL 目标的入口（04B 验收一：不存在 arbitrary URL fetch）。
from __future__ import annotations

from typing import Iterable
from urllib.parse import SplitResult, urlsplit

from .errors import AllowlistViolation


def assert_url_allowed(url: str, allowed_hosts: Iterable[str]) -> SplitResult:
    """校验 URL：https、无内嵌凭据、默认端口、host 精确命中白名单。

    @raise AllowlistViolation: 任一条件不满足（此时零网络调用）。
    @return: 解析后的结果（调用方可直接取 .hostname/.path）。
    """
    hosts = {h.strip().lower() for h in allowed_hosts if h.strip()}
    if not hosts:
        raise AllowlistViolation("该连接器未配置任何允许域名（白名单为空，拒绝一切请求）")

    parts = urlsplit(url)
    if parts.scheme != "https":
        raise AllowlistViolation(f"仅允许 https URL，收到 scheme={parts.scheme or '（空）'}")
    if parts.username is not None or parts.password is not None:
        raise AllowlistViolation("URL 不得内嵌凭据（user:pass@）")
    if parts.hostname is None:
        raise AllowlistViolation("URL 缺少主机名")
    if parts.port not in (None, 443):
        raise AllowlistViolation(f"仅允许默认端口 443，收到 port={parts.port}")

    hostname = parts.hostname.lower()
    if hostname not in hosts:
        # 白名单外域名：不发起任何连接
        raise AllowlistViolation(f"域名不在允许清单内：{hostname}")
    return parts
