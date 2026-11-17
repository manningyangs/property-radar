// TASK-06D：任务和质量后台只读端点（PRD 任务行 1368–1374 / §8.6 / §8.7 / §10.5）
// 端点：GET /admin/jobs（采集任务日志：搜索/筛选/排序/分页 + 近 7 日摘要）、
//       GET /admin/quality/issues（四类异常只读聚合：failed jobs / 健康 ≠ ok / 非 valid 观测 /
//       离群快照（TASK-09 R3 双源中位数交叉核验超 15% 阈值））。
// 验收一「每一异常可定位 source、batch、connector version 和具体错误码」：
//   每条 issue 带 locator 形态——job→job_id/error_code/connector_version/workflow_url；
//   health→report_id/detail/checked_at；observation→observation_id/batch_id/connector_version/quality_status。
// 验收二「重跑有幂等保护」：Worker 不执行 connector、无重跑路径（拍板 3）——
//   幂等由此前链路保证（同 batch_id 重提 202 duplicate、observation 确定性 ID upsert、
//   finish 幂等不改写），admin-ops.test.ts 单测实证，页面详情标注说明。
// 拍板 4：§8.7 标记误报/确认异常/重处理批次等写操作留后续任务，本文件纯只读。
// 门禁：requireAdminAccess 统一挂 use("*")（06A 会话+角色+MFA），与 06B/06C 同模式。
import { Hono, type Context } from "hono";
import { requireAdminAccess } from "../auth";
import { errors } from "../errors";
import { type AppEnv } from "../env";

export const adminOpsRoutes = new Hono<AppEnv>();

adminOpsRoutes.use("*", requireAdminAccess);

/** 整数查询参数（与 06B 同风格：越界/非法 → 400 validation） */
function intQuery(
  raw: string | undefined,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw errors.validation([
      { field: `/${name}`, message: `必须是 ${min}–${max} 的整数` },
    ]);
  }
  return n;
}

/** LIKE 模式转义（\ % _ 三字符；配合 ESCAPE '\'） */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** 跨库来源名映射（Public 库；Private 库任务/健康/观测只存 source_id） */
async function sourceNames(
  c: Context<AppEnv>,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const marks = ids.map(() => "?").join(", ");
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id, name FROM data_sources_public WHERE source_id IN (${marks})`,
  )
    .bind(...ids)
    .all<{ source_id: string; name: string }>();
  return new Map(res.results.map((r) => [r.source_id, r.name]));
}

interface JobRow {
  job_id: string;
  source_id: string;
  city_code: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  note: string | null;
  run_type: string | null;
  records_fetched: number | null;
  records_accepted: number | null;
  records_rejected: number | null;
  communities_covered: number | null;
  connector_version: string | null;
  workflow_url: string | null;
}

const JOB_SELECT = `SELECT job_id, source_id, city_code, status, started_at,
       finished_at, error_code, note, run_type, records_fetched,
       records_accepted, records_rejected, communities_covered,
       connector_version, workflow_url
FROM ingest_jobs`;

// GET /admin/jobs —— §8.6 全字段任务日志（搜索/筛选/排序/分页 + 近 7 日 summary）
adminOpsRoutes.get("/jobs", async (c) => {
  const sourceId = c.req.query("source_id")?.trim() || "";
  const cityCode = c.req.query("city_code")?.trim() || "";
  const status = c.req.query("status")?.trim() || "";
  const q = c.req.query("q")?.trim() || "";
  if (status && !["running", "succeeded", "failed"].includes(status)) {
    throw errors.validation([
      { field: "/status", message: "status 须为 running/succeeded/failed" },
    ]);
  }
  const sort = c.req.query("sort") || "started_at";
  if (!["started_at", "finished_at"].includes(sort)) {
    throw errors.validation([
      { field: "/sort", message: "sort 须为 started_at/finished_at" },
    ]);
  }
  const order = (c.req.query("order") || "desc").toLowerCase();
  if (order !== "asc" && order !== "desc") {
    throw errors.validation([
      { field: "/order", message: "order 须为 asc/desc" },
    ]);
  }
  const limit = intQuery(c.req.query("limit"), "limit", 20, 1, 100);
  const offset = intQuery(c.req.query("offset"), "offset", 0, 0, 5000);

  const where: string[] = [];
  const binds: Array<string | number> = [];
  if (sourceId) {
    where.push("source_id = ?");
    binds.push(sourceId);
  }
  if (cityCode) {
    where.push("city_code = ?");
    binds.push(cityCode);
  }
  if (status) {
    where.push("status = ?");
    binds.push(status);
  }
  if (q) {
    where.push("(job_id LIKE ? ESCAPE '\\' OR source_id LIKE ? ESCAPE '\\')");
    const p = likePattern(q);
    binds.push(p, p);
  }
  const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

  const [cnt, list] = await Promise.all([
    c.env.DB_PRIVATE.prepare(`SELECT COUNT(*) AS n FROM ingest_jobs${whereSql}`)
      .bind(...binds)
      .first<{ n: number }>(),
    c.env.DB_PRIVATE.prepare(
      `${JOB_SELECT}${whereSql}
       ORDER BY ${sort} ${order.toUpperCase()}, job_id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<JobRow>(),
  ]);

  const names = await sourceNames(c, [
    ...new Set(list.results.map((r) => r.source_id)),
  ]);

  // 近 7 日摘要（指标卡「任务成功率」同源口径）
  const sumRes = await c.env.DB_PRIVATE.prepare(
    `SELECT status, COUNT(*) AS n FROM ingest_jobs
     WHERE started_at >= datetime('now', '-7 day') GROUP BY status`,
  ).all<{ status: string; n: number }>();
  const jobs7d: { succeeded: number; failed: number; running: number } = {
    succeeded: 0,
    failed: 0,
    running: 0,
  };
  for (const row of sumRes.results) {
    if (
      row.status === "succeeded" ||
      row.status === "failed" ||
      row.status === "running"
    )
      jobs7d[row.status] = row.n;
  }
  const denom = jobs7d.succeeded + jobs7d.failed;

  return c.json({
    items: list.results.map((r) => ({
      ...r,
      source_name: names.get(r.source_id) ?? r.source_id,
    })),
    count: cnt?.n ?? 0,
    limit,
    offset,
    summary: {
      jobs_7d: jobs7d,
      success_rate:
        denom === 0 ? null : Number((jobs7d.succeeded / denom).toFixed(4)),
    },
  });
});

/** 质量异常统一形态（kind 决定 locator 内字段集） */
interface QualityIssue {
  issue_kind: "job_failed" | "health" | "observation" | "snapshot";
  source_id: string;
  source_name: string;
  occurred_at: string;
  note: string | null;
  locator: Record<string, unknown>;
}

const ISSUE_KINDS = new Set([
  "job_failed",
  "health",
  "observation",
  "snapshot",
]);
const BAD_QUALITY = ["low_sample", "stale", "outlier", "rejected"];

// GET /admin/quality/issues —— 四类异常只读聚合（每类各取窗口 → 合并按时间倒序分页；
// snapshot 类 = TASK-09 R3 双源中位数交叉核验超阈值离群快照）
adminOpsRoutes.get("/quality/issues", async (c) => {
  const kind = c.req.query("kind")?.trim() || "";
  if (kind && !ISSUE_KINDS.has(kind)) {
    throw errors.validation([
      {
        field: "/kind",
        message: "kind 须为 job_failed/health/observation/snapshot",
      },
    ]);
  }
  const sourceId = c.req.query("source_id")?.trim() || "";
  const limit = intQuery(c.req.query("limit"), "limit", 30, 1, 100);
  const offset = intQuery(c.req.query("offset"), "offset", 0, 0, 5000);
  const want = (k: QualityIssue["issue_kind"]) => !kind || kind === k;

  const srcFilter = sourceId ? " AND source_id = ?" : "";
  const srcBinds = sourceId ? [sourceId] : [];

  const [failedCnt, obsCnt, failedRes, obsRes, reportsRes, snapCnt, snapRes] =
    await Promise.all([
      want("job_failed")
        ? c.env.DB_PRIVATE.prepare(
            `SELECT COUNT(*) AS n FROM ingest_jobs WHERE status = 'failed'${srcFilter}`,
          )
            .bind(...srcBinds)
            .first<{ n: number }>()
        : Promise.resolve(null),
      want("observation")
        ? c.env.DB_PUBLIC.prepare(
            `SELECT COUNT(*) AS n FROM price_observations
             WHERE quality_status IN (${BAD_QUALITY.map(() => "?").join(", ")})${srcFilter}`,
          )
            .bind(...BAD_QUALITY, ...srcBinds)
            .first<{ n: number }>()
        : Promise.resolve(null),
      want("job_failed")
        ? c.env.DB_PRIVATE.prepare(
            `${JOB_SELECT} WHERE status = 'failed'${srcFilter}
             ORDER BY COALESCE(finished_at, started_at) DESC, job_id DESC
             LIMIT ?`,
          )
            .bind(...srcBinds, limit + offset)
            .all<JobRow>()
        : Promise.resolve({ results: [] as JobRow[] }),
      want("observation")
        ? c.env.DB_PUBLIC.prepare(
            `SELECT observation_id, source_id, object_id, price_type, metric_code,
                    stat_date, quality_status, connector_version, batch_id, collected_at
             FROM price_observations
             WHERE quality_status IN (${BAD_QUALITY.map(() => "?").join(", ")})${srcFilter}
             ORDER BY collected_at DESC, observation_id DESC
             LIMIT ?`,
          )
            .bind(...BAD_QUALITY, ...srcBinds, limit + offset)
            .all<ObsIssueRow>()
        : Promise.resolve({ results: [] as ObsIssueRow[] }),
      want("health")
        ? c.env.DB_PRIVATE.prepare(
            `SELECT report_id, source_id, status, latency_ms, detail, checked_at
             FROM source_health_reports WHERE 1 = 1${srcFilter}
             ORDER BY checked_at DESC, report_id DESC LIMIT 2000`,
          )
            .bind(...srcBinds)
            .all<HealthReportRow>()
        : Promise.resolve({ results: [] as HealthReportRow[] }),
      want("snapshot")
        ? c.env.DB_PUBLIC.prepare(
            `SELECT COUNT(*) AS n FROM price_snapshots
             WHERE quality_status = 'outlier'${srcFilter}`,
          )
            .bind(...srcBinds)
            .first<{ n: number }>()
        : Promise.resolve(null),
      want("snapshot")
        ? c.env.DB_PUBLIC.prepare(
            `SELECT snapshot_id, source_id, object_type, object_id, price_type,
                    metric_code, stat_date, median, sample_count, collected_at
             FROM price_snapshots
             WHERE quality_status = 'outlier'${srcFilter}
             ORDER BY collected_at DESC, snapshot_id DESC
             LIMIT ?`,
          )
            .bind(...srcBinds, limit + offset)
            .all<SnapIssueRow>()
        : Promise.resolve({ results: [] as SnapIssueRow[] }),
    ]);

  // 健康类：每来源取最新报告，仅 ≠ ok 者成 issue（down/degraded 必须可见——04B 同义）
  const latestBySource = new Map<string, HealthReportRow>();
  for (const r of reportsRes.results) {
    if (!latestBySource.has(r.source_id)) latestBySource.set(r.source_id, r);
  }
  const healthIssues: QualityIssue[] = [];
  for (const r of latestBySource.values()) {
    if (r.status === "ok") continue;
    healthIssues.push({
      issue_kind: "health",
      source_id: r.source_id,
      source_name: "",
      occurred_at: r.checked_at,
      note: r.detail,
      locator: {
        report_id: r.report_id,
        health_status: r.status,
        latency_ms: r.latency_ms,
        detail: r.detail,
      },
    });
  }

  const jobIssues: QualityIssue[] = failedRes.results.map((r) => ({
    issue_kind: "job_failed" as const,
    source_id: r.source_id,
    source_name: "",
    occurred_at: r.finished_at ?? r.started_at,
    note: r.note,
    locator: {
      job_id: r.job_id,
      error_code: r.error_code,
      connector_version: r.connector_version,
      workflow_url: r.workflow_url,
      run_type: r.run_type,
      city_code: r.city_code,
      records_fetched: r.records_fetched,
      records_accepted: r.records_accepted,
      records_rejected: r.records_rejected,
    },
  }));

  const obsIssues: QualityIssue[] = obsRes.results.map((r) => ({
    issue_kind: "observation" as const,
    source_id: r.source_id,
    source_name: "",
    occurred_at: r.collected_at,
    note: null,
    locator: {
      observation_id: r.observation_id,
      batch_id: r.batch_id,
      connector_version: r.connector_version,
      quality_status: r.quality_status,
      object_id: r.object_id,
      price_type: r.price_type,
      metric_code: r.metric_code,
      stat_date: r.stat_date,
    },
  }));

  // TASK-09 R3：离群快照成 issue（双源中位数交叉核验超阈值——median 等仍留痕可见）
  const snapIssues: QualityIssue[] = snapRes.results.map((r) => ({
    issue_kind: "snapshot" as const,
    source_id: r.source_id,
    source_name: "",
    occurred_at: r.collected_at,
    note: "双源中位数相对偏差超过 15% 阈值（TASK-09 R3 交叉核验）",
    locator: {
      snapshot_id: r.snapshot_id,
      object_type: r.object_type,
      object_id: r.object_id,
      price_type: r.price_type,
      metric_code: r.metric_code,
      stat_date: r.stat_date,
      median: r.median,
      sample_count: r.sample_count,
    },
  }));

  const merged = [
    ...jobIssues,
    ...healthIssues,
    ...obsIssues,
    ...snapIssues,
  ].sort(
    (a, b) =>
      b.occurred_at.localeCompare(a.occurred_at) ||
      a.source_id.localeCompare(b.source_id),
  );
  const page = merged.slice(offset, offset + limit);

  const names = await sourceNames(c, [
    ...new Set(page.map((i) => i.source_id)),
  ]);
  for (const issue of page)
    issue.source_name = names.get(issue.source_id) ?? issue.source_id;

  return c.json({
    items: page,
    count: merged.length,
    limit,
    offset,
    counts: {
      job_failed: failedCnt?.n ?? 0,
      health: want("health") ? healthIssues.length : 0,
      observation: obsCnt?.n ?? 0,
      snapshot: snapCnt?.n ?? 0,
    },
  });
});

interface SnapIssueRow {
  snapshot_id: string;
  source_id: string;
  object_type: string;
  object_id: string;
  price_type: string;
  metric_code: string;
  stat_date: string;
  median: number | null;
  sample_count: number | null;
  collected_at: string;
}

interface ObsIssueRow {
  observation_id: string;
  source_id: string;
  object_id: string;
  price_type: string;
  metric_code: string;
  stat_date: string;
  quality_status: string;
  connector_version: string | null;
  batch_id: string | null;
  collected_at: string;
}

interface HealthReportRow {
  report_id: string;
  source_id: string;
  status: string;
  latency_ms: number | null;
  detail: string | null;
  checked_at: string;
}
