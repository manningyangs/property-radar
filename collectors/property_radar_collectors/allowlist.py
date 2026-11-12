# TASK-04B：域名静态白名单（PRD §5.6-1：有静态 allowlist 域名，不接受任意 URL 直连）
# 校验必须发生在任何网络 I/O 之前；白名单只来源于代码/配置常量，
# 不提供运行时注入任意 URL 目标的入口（04B 验收一：不存在 arbitrary URL fetch）。
# TASK-04C：支持「显式声明的 http 例外主机」——仅当 host 同时在白名单且在
# allow_http_hosts（仍为代码常量）中才允许明文 http（如青岛市统计局站点 https 证书无效）；
# 其余主机、其余 scheme、非默认端口一律拒绝（fail closed 不变）。
from __future__ import annotations

from typing import Iterable
from urllib.parse import SplitResult, urlsplit

from .errors import AllowlistViolation


def assert_url_allowed(
    url: str,
    allowed_hosts: Iterable[str],
    *,
    allow_http_hosts: Iterable[str] = (),
) -> SplitResult:
    """校验 URL：https（或显式声明的 http 例外）、无内嵌凭据、默认端口、host 精确命中白名单。

    @raise AllowlistViolation: 任一条件不满足（此时零网络调用）。
    @return: 解析后的结果（调用方可直接取 .hostname/.path）。
    """
    hosts = {h.strip().lower() for h in allowed_hosts if h.strip()}
    if not hosts:
        raise AllowlistViolation("该连接器未配置任何允许域名（白名单为空，拒绝一切请求）")
    http_hosts = {h.strip().lower() for h in allow_http_hosts if h.strip()}
    if not http_hosts <= hosts:
        # 配置一致性：http 例外必须是白名单子集（双保险，防止例外脱离白名单）
        raise AllowlistViolation("http 例外域名必须同时存在于允许清单内")

    parts = urlsplit(url)
    if parts.scheme not in ("https", "http"):
        raise AllowlistViolation(f"仅允许 https（或显式声明的 http 例外），收到 scheme={parts.scheme or '（空）'}")
    if parts.username is not None or parts.password is not None:
        raise AllowlistViolation("URL 不得内嵌凭据（user:pass@）")
    if parts.hostname is None:
        raise AllowlistViolation("URL 缺少主机名")

    hostname = parts.hostname.lower()
    if parts.scheme == "http":
        if hostname not in http_hosts:
            # 明文 http 仅限显式例外主机；白名单内但未声明 http 的主机同样拒绝
            raise AllowlistViolation(f"该主机不允许明文 http（未在 http 例外清单中）：{hostname}")
        if parts.port not in (None, 80):
            raise AllowlistViolation(f"仅允许默认端口 80，收到 port={parts.port}")
    else:
        if parts.port not in (None, 443):
            raise AllowlistViolation(f"仅允许默认端口 443，收到 port={parts.port}")

    if hostname not in hosts:
        # 白名单外域名：不发起任何连接
        raise AllowlistViolation(f"域名不在允许清单内：{hostname}")
    return parts
