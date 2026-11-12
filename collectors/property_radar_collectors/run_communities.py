# TASK-04D：小区挂牌验证管线 CLI（spec R5 SubTask 5.4 / PRD 任务行 1304–1310）
# 全链（与 run_daily 同骨架，观测明细随批次下发）：
#   run_guard 资格预检（fang_com 未 approved → 零采集请求终止）
#   → health_check + report_health → jobs/start
#   → 逐小区 fetch 列表首页（≤30 套）→ normalize → ingest/batch(observed_count + observations)
#   → jobs/finish(succeeded|failed)
# 边界（spec R5）：仅白名单三主机全 https；每小区仅列表首页；限速 ≥1s（SafeHttp 默认）；
# 无 listing_url 的小区零请求跳过；挑战页/解析失败如实记数不伪造；不入 cron。
# 用法（cwd=collectors）：
#   真实运行: python -m property_radar_collectors.run_communities   # 环境变量 API_BASE / INGEST_HMAC_SECRET
#   离线回放: python -m property_radar_collectors.run_communities --fixture tests/fixtures/fang --run-date 2026-11-12
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

from .errors import ConnectorError, ValidationError, redact
from .fang_community import (
    CITY_CODE,
    OBJECT_LEVEL,
    SOURCE_ID,
    FangCommunityConnector,
    load_communities,
)
from .http import SafeHttpClient
from .internal_client import InternalApiClient
from .runner import run_guard
from .schema import NormalizedObservation

TZ = ZoneInfo("Asia/Shanghai")
_LOUPAN_PATH_RE = re.compile(r"/loupan/(\d+)/")


def build_fixture_transport(directory: str) -> httpx.MockTransport:
    """把 fixture 目录映射为传输层（零出网回放）。

    首页 / → fang_home.html；/loupan/<id>/chushou/list/ → <id>.html；缺失 → 404。
    """
    root = Path(directory)

    def handler(request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path
        if path in ("/", ""):
            name = "fang_home.html"
        else:
            m = _LOUPAN_PATH_RE.search(path)
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


def _build_connector(fixture_dir: str | None, source_transport) -> FangCommunityConnector:
    if fixture_dir:
        transport: httpx.BaseTransport = build_fixture_transport(fixture_dir)
    else:
        transport = source_transport
    if transport is None:
        return FangCommunityConnector()
    http = SafeHttpClient(
        FangCommunityConnector.allowed_hosts,
        allow_http_hosts=FangCommunityConnector.allowed_insecure_hosts,
        transport=transport,
    )
    return FangCommunityConnector(http=http)


def _to_batch_observation(observation: "NormalizedObservation") -> dict:
    """NormalizedObservation → ingest/batch observations[] 条目（schemas.ts OBSERVATION_ITEM 同口径）。"""
    return {
        "object_id": observation.object_id,
        "property_type": observation.property_type,
        "price_type": observation.price_type,
        "metric_code": observation.metric_code,
        "price_total_fen": observation.price_total_fen,
        "unit_price_yuan_sqm": observation.unit_price_yuan_sqm,
        "area_sqm": observation.area_sqm,
        "sample_count": observation.sample_count,
        "stat_date": observation.stat_date,
        "quality_status": observation.quality_status,
        "connector_version": observation.connector_version,
    }


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="run_communities",
        description="青岛首批小区房天下挂牌列表验证采集与状态上报（04D，不入 cron）",
    )
    p.add_argument("--run-date", help="运行日 YYYY-MM-DD（缺省：今日 Asia/Shanghai）")
    p.add_argument("--api-base", help="internal API 前缀（缺省：环境变量 API_BASE）")
    p.add_argument("--job-id", help="任务 ID（缺省：qd_fang_<run-date>）")
    p.add_argument("--limit", type=int, help="只跑前 N 个有 URL 的小区（验证用抽样）")
    p.add_argument(
        "--fixture",
        help="离线回放：fixture 目录（fang_home.html + <loupan_id>.html），零出网",
    )
    p.add_argument(
        "--config",
        help="小区→URL 配置（缺省：config/cities/qingdao-community-listings.json）",
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

    job_id = args.job_id or f"qd_fang_{run_date}"

    try:
        communities = load_communities(args.config)
    except (ConnectorError, OSError, ValueError) as exc:
        print(f"错误：配置加载失败：{redact(str(exc))}", file=sys.stderr)
        return 2

    # 无 listing_url 小区零请求跳过（浮山后四小区等 6 个 00B 无链接项）
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
        empty: list[str] = []  # 页面 200 但 0 套（含挑战页为失败路径，见下）
        failures: list[str] = []  # 逐小区抓取/解析失败，不中断其余小区

        for community in with_url:
            cid = str(community.get("community_id"))
            try:
                # 04B 社区级接口（04D 首次真实实现）；无 URL 小区已在 with_url 过滤，零请求
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
                    "batch_id": f"qd_fang_{run_date}_{cid}",
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
