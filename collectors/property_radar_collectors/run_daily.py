# TASK-04C：每日运行 CLI（PRD §6.6 定时任务 / §11.1 日更流程 / 任务行 1296–1302）
# 流程（每步失败都尽量留下任务状态）：
#   run_guard 资格预检（未 approved → 零采集请求终止）
#   → health_check + report_health → jobs/start
#   → fetch_region_data → normalize(每期 ×4 双口径) → ingest/batch(observed_count + observations 明细)
#   → jobs/finish(succeeded|failed)
# 用法（cwd=collectors）：
#   真实运行: python -m property_radar_collectors.run_daily            # 环境变量 API_BASE / INGEST_HMAC_SECRET
#   离线回放: python -m property_radar_collectors.run_daily --fixture tests/fixtures --run-date 2026-11-05
# 密钥只从环境变量读取；输出与日志经 redact 脱敏（PRD §5.6-6）。
from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import httpx

from .errors import ConnectorError, redact
from .http import SafeHttpClient
from .internal_client import InternalApiClient
from .qingdao_index import (
    AUTHORIZED_REGION,
    LIST_URL,
    QdStatsIndexConnector,
    index_observations,
)
from .runner import run_guard

SOURCE_ID = QdStatsIndexConnector.source_code
OBJECT_LEVEL = "city"
# 采集窗口：覆盖上月发布 + 跳月的宽松回看窗（核验报告 §4：月更且存在跳月）
WINDOW_DAYS = 45
TZ = ZoneInfo("Asia/Shanghai")


def build_fixture_transport(directory: str) -> httpx.MockTransport:
    """把 fixture 目录映射为传输层（零出网回放）。

    路径以 / 结尾 → qd_list.shtml（栏目列表页）；否则取路径末段同名文件；缺失 → 404。
    """
    root = Path(directory)

    def handler(request: httpx.Request) -> httpx.Response:
        path = urlparse(str(request.url)).path
        name = "qd_list.shtml" if path.endswith("/") else Path(path).name
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


def _build_connector(fixture_dir: str | None, source_transport) -> QdStatsIndexConnector:
    if fixture_dir:
        transport = build_fixture_transport(fixture_dir)
    else:
        transport = source_transport
    if transport is None:
        return QdStatsIndexConnector()
    http = SafeHttpClient(
        QdStatsIndexConnector.allowed_hosts,
        allow_http_hosts=QdStatsIndexConnector.allowed_insecure_hosts,
        transport=transport,
    )
    return QdStatsIndexConnector(http=http)


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="run_daily",
        description="青岛市统计局住宅价格指数每日采集与状态上报",
    )
    p.add_argument("--run-date", help="运行日 YYYY-MM-DD（缺省：今日 Asia/Shanghai）")
    p.add_argument("--api-base", help="internal API 前缀（缺省：环境变量 API_BASE）")
    p.add_argument("--job-id", help=f"任务 ID（缺省：qd_idx_<run-date>）")
    p.add_argument(
        "--fixture",
        help="离线回放：fixture 目录（qd_list.shtml + 期次 .shtml），零出网",
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
        run_day = date.fromisoformat(run_date)
    except ValueError:
        print(f"错误：--run-date 不是 YYYY-MM-DD：{run_date!r}", file=sys.stderr)
        return 2

    job_id = args.job_id or f"qd_idx_{run_date}"
    batch_id = f"qd_batch_{run_date}"
    window_start = (run_day - timedelta(days=WINDOW_DAYS)).isoformat()
    date_range = (window_start, run_date)

    client = InternalApiClient(api_base, transport=api_transport)
    connector = _build_connector(args.fixture, source_transport)
    job_started = False

    try:
        # 1) 资格门禁：未 approved / 超覆盖 → 零采集请求终止（04B 验收二）
        eligibility = run_guard(client, SOURCE_ID, AUTHORIZED_REGION, OBJECT_LEVEL)

        # 2) 来源健康（此时已获准采集）
        health = connector.health_check()
        health_payload = {
            "source_id": SOURCE_ID,
            "status": health.status,
            "detail": health.detail,
        }
        if health.latency_ms is not None:
            health_payload["latency_ms"] = health.latency_ms
        client.report_health(health_payload)

        # 3) 任务状态：开始 → 采集/归一化 → 批次 → 结束
        client.job_start(
            {
                "job_id": job_id,
                "source_id": SOURCE_ID,
                "city_code": AUTHORIZED_REGION,
                "object_level": OBJECT_LEVEL,
            }
        )
        job_started = True

        records = connector.fetch_region_data([AUTHORIZED_REGION], date_range)
        observations = [o for r in records for o in index_observations(r)]
        # TASK-04E：携带明细让 04C 指数（同比/环比 × 新建/二手）真正落库——
        # observed_count 与明细长度一致（服务端 04D 交叉校验；04C 独有拒绝计数在此无拒绝，
        # 规范拒绝数（对象/统计日/值域）由服务端 04E 清洗以 400 details 返回，批次拒绝即留痕）
        client.submit_batch(
            {
                "batch_id": batch_id,
                "source_id": SOURCE_ID,
                "city_code": AUTHORIZED_REGION,
                "object_level": OBJECT_LEVEL,
                "observed_count": len(observations),
                "observations": [o.to_ingest_item() for o in observations],
            }
        )
        periods = ",".join(r.fields["report_period"] for r in records) or "无新期次"
        note = f"run_date={run_date}; 期次={periods}; 观测={len(observations)}"
        client.job_finish(job_id, "succeeded", note=note)

        print(
            f"[成功] run_date={run_date} job_id={job_id} "
            f"期次={len(records)} 观测={len(observations)} "
            f"资格={eligibility.get('status', 'approved')} 健康={health.status}"
        )
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
