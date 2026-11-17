# TASK-09：贝壳小区挂牌验证管线 CLI（spec R1；与 run_communities 同骨架，不入 cron）
# 全链：
#   run_guard 资格预检（beike 未 approved → 零采集请求终止）
#   → health_check + report_health → jobs/start
#   → 逐小区 fetch 挂牌首页（≤30 套）→ normalize → ingest/batch(observed_count + observations)
#   → jobs/finish(succeeded|failed)
# 边界（spec §0-1 负责人 2026-11-17 裁决）：仅白名单 qd.ke.com；每小区仅列表首页；
# 限速 ≥1s（SafeHttp 默认）；无 listing_url 小区零请求跳过；登录/验证墙如实报 down/失败不绕过；
# 不入 cron/workflow（手工触发专用）。
# 用法（cwd=collectors）：
#   真实运行: python -m property_radar_collectors.run_beike   # 环境变量 API_BASE / INGEST_HMAC_SECRET
#   离线回放: python -m property_radar_collectors.run_beike --fixture tests/fixtures/beike --run-date 2026-11-17
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx

from .beike_community import (
    CITY_CODE,
    OBJECT_LEVEL,
    SOURCE_ID,
    BeikeCommunityConnector,
    load_communities,
)
from .errors import ConnectorError, ValidationError, redact
from .http import SafeHttpClient
from .internal_client import InternalApiClient
from .runner import run_guard
from .schema import NormalizedObservation

TZ = ZoneInfo("Asia/Shanghai")
_RESBLOCK_PATH_RE = re.compile(r"/ershoufang/c(\d+)/")


def build_fixture_transport(directory: str) -> httpx.MockTransport:
    """把 fixture 目录映射为传输层（零出网回放）。

    首页 / → beike_home.html；/ershoufang/c<id>/ → <id>.html；缺失 → 404。
    """
    root = Path(directory)

    def handler(request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path
        if path in ("/", ""):
            name = "beike_home.html"
        else:
            m = _RESBLOCK_PATH_RE.search(path)
            name = f"{m.group(1)}.html" if m else Path(path).name
        target = root / name
        if not target.is_file():
            return httpx.Response(404, request=request)
        return httpx.Response(
            200,
            content=target.read_bytes(),
            headers={"content-type": "text/html; charset=utf-8"},
            request=request,
        )

    return httpx.MockTransport(handler)


def _build_connector(fixture_dir: str | None, source_transport) -> BeikeCommunityConnector:
    if fixture_dir:
        transport: httpx.BaseTransport = build_fixture_transport(fixture_dir)
    else:
        transport = source_transport
    if transport is None:
        return BeikeCommunityConnector()
    http = SafeHttpClient(
        BeikeCommunityConnector.allowed_hosts,
        allow_http_hosts=BeikeCommunityConnector.allowed_insecure_hosts,
        transport=transport,
    )
    return BeikeCommunityConnector(http=http)


def _to_batch_observation(observation: "NormalizedObservation") -> dict:
    """NormalizedObservation → ingest/batch observations[] 条目（schema 同口径 12 键）。"""
    return observation.to_ingest_item()


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="run_beike",
        description="青岛首批小区贝壳挂牌列表验证采集与状态上报（TASK-09，不入 cron）",
    )
    p.add_argument("--run-date", help="运行日 YYYY-MM-DD（缺省：今日 Asia/Shanghai）")
    p.add_argument("--api-base", help="internal API 前缀（缺省：环境变量 API_BASE）")
    p.add_argument("--job-id", help="任务 ID（缺省：qd_beike_<run-date>）")
    p.add_argument("--limit", type=int, help="只跑前 N 个有 URL 的小区（验证用抽样）")
    p.add_argument(
        "--fixture",
        help="离线回放：fixture 目录（beike_home.html + <xiaoqu_id>.html），零出网",
    )
    p.add_argument(
        "--config",
        help="小区→URL 配置（缺省：config/cities/qingdao-community-listings-beike.json）",
    )
    return p.parse_args(argv)


def main(
    argv: list[str] | None = None,
    *,
    api_transport: httpx.BaseTransport | None = None,
    source_transport: httpx.BaseTransport | None = None,
) -> int:
    """CLI 主入口。api_transport/source_transport 仅供测试注入（pytest 不出网）。"""
    args = _parse_args(argv)

    api_base = (args.api_base or os.environ.get("API_BASE", "")).strip()
    if not api_base:
        print("错误：缺少 --api-base 或环境变量 API_BASE", file=sys.stderr)
        return 2

    run_date = args.run_date or datetime.now(TZ).date().isoformat()
    try:
        date.fromisoformat(run_date)
    except ValueError:
        print(f"错误：--run-date 不是 YYYY-MM-DD：{run_date!r}", file=sys.stderr)
        return 2

    job_id = args.job_id or f"qd_beike_{run_date}"

    try:
        communities = load_communities(args.config)
    except (ConnectorError, OSError, ValueError) as exc:
        print(f"错误：配置加载失败：{redact(str(exc))}", file=sys.stderr)
        return 2

    # 无 listing_url 小区零请求跳过（公开渠道不可核验小区如实置 null）
    with_url = [c for c in communities if c.get("listing_url")]
    if args.limit is not None:
        if args.limit < 1:
            print(f"错误：--limit 必须 ≥1：{args.limit}", file=sys.stderr)
            return 2
        with_url = with_url[: args.limit]
    no_url_ids = [
        c.get("community_id") for c in communities if not c.get("listing_url")
    ]

    client = InternalApiClient(api_base, transport=api_transport)
    connector = _build_connector(args.fixture, source_transport)
    job_started = False

    try:
        # 1) 资格门禁：未 approved / 超覆盖 → 零采集请求终止（04B 验收二）
        eligibility = run_guard(client, SOURCE_ID, CITY_CODE, OBJECT_LEVEL)

        # 2) 来源健康（此时已获准采集；detail 为 None 时不下发——schema 只收 string）
        health = connector.health_check()
        health_payload: dict = {
            "source_id": SOURCE_ID,
            "status": health.status,
        }
        if health.detail is not None:
            health_payload["detail"] = health.detail
        if health.latency_ms is not None:
            health_payload["latency_ms"] = health.latency_ms
        client.report_health(health_payload)

        # 3) 任务状态：开始 → 逐小区采集/归一化/批次 → 结束
        client.job_start(
            {
                "job_id": job_id,
                "source_id": SOURCE_ID,
                "city_code": CITY_CODE,
                "object_level": OBJECT_LEVEL,
            }
        )
        job_started = True

        batches = 0
        observations_total = 0
        rejected = 0  # 归一化拒绝（极端价格等护栏），如实计数
        empty: list[str] = []  # 页面 200 但 0 套（挑战页为失败路径，见下）
        failures: list[str] = []  # 逐小区抓取/解析失败（含登录墙），不中断其余小区

        for community in with_url:
            cid = str(community.get("community_id"))
            try:
                records = connector.fetch_community_data([cid], (run_date, run_date))
            except ConnectorError as exc:
                failures.append(f"{cid}:{exc.code}")
                continue
            if not records:
                empty.append(cid)
                continue

            observations: list[dict] = []
            for record in records:
                try:
                    normalized = connector.normalize(
                        record, price_type="listing_ask", metric_code="listing_ask_unit"
                    )
                except ValidationError:
                    rejected += 1  # 护栏拒绝单套，不影响该小区其余样本
                    continue
                observations.append(_to_batch_observation(normalized))
            if not observations:
                empty.append(cid)
                continue

            client.submit_batch(
                {
                    "batch_id": f"qd_beike_{run_date}_{cid}",
                    "source_id": SOURCE_ID,
                    "city_code": CITY_CODE,
                    "object_level": OBJECT_LEVEL,
                    "observed_count": len(observations),
                    "observations": observations,
                }
            )
            batches += 1
            observations_total += len(observations)

        note = (
            f"run_date={run_date}; 配置小区={len(communities)}; 无链接跳过={len(no_url_ids)}; "
            f"批次={batches}; 观测={observations_total}; 空页={len(empty)}; "
            f"拒绝={rejected}; 失败={len(failures)}"
            + (f" ({','.join(failures[:5])})" if failures else "")
        )

        # 全部小区抓取失败且零批次：任务如实判失败（不把全量失败报成成功）
        if batches == 0 and failures:
            client.job_finish(job_id, "failed", error_code="all_communities_failed", note=note)
            print(f"[失败] {note}", file=sys.stderr)
            return 1

        client.job_finish(job_id, "succeeded", note=note)

        print(
            f"[成功] run_date={run_date} job_id={job_id} 批次={batches} "
            f"观测={observations_total} 无链接跳过={len(no_url_ids)} "
            f"空页={len(empty)} 拒绝={rejected} 失败={len(failures)} "
            f"资格={eligibility.get('status', 'approved')} 健康={health.status}"
        )
        if failures:
            print(f"[提示] 逐小区失败明细：{'; '.join(failures[:10])}", file=sys.stderr)
        return 0

    except ConnectorError as exc:
        if job_started:
            try:
                client.job_finish(
                    job_id,
                    "failed",
                    error_code=exc.code,
                    note=redact(f"run_date={run_date}; {exc}")[:500],
                )
            except ConnectorError:
                pass  # 上游同时不可用时保留原始失败原因
        print(f"[失败] {exc.code}: {exc}", file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
