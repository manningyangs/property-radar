// TASK-04A：数据源许可门禁（PRD 任务行 1284–1286 / §5.2 状态机 / §5.6 连接器规范 / §11.1-2）
// 职责：
//   1) resolveLicense —— 读取许可状态 + 惰性过期自动 suspend（approved_* 且 valid_until 已过 →
//      写回 suspended、coverage 同步 suspended、写审计，不引入调度器）；
//   2) assertIngestAllowed —— 批次/连接器入管线前的四段门禁：来源存在 → 状态已批准 →
//      source_city_coverage 授权覆盖 → cities.status 可采集。04B connector 与 internal 批次端点共用。
// 门禁只读判定（过期副作用除外）；错误一律走稳定 error_code，不泄露库结构。
import {
  AUTOMATION_ALLOWED_STATUSES,
  type SourceStatus,
} from "@property-radar/shared";
import { errors } from "./errors";
import type { Env } from "./env";

/** coverage.authorization_status 中允许自动采集的取值（§9.1 枚举含历史值 'approved'） */
export const APPROVED_COVERAGE_STATUSES = [
  "approved",
  "approved_open",
  "approved_licensed",
] as const;

/** 可开启自动监控的城市状态（附录 B auto_monitor_only_statuses） */
export const AUTOMATION_CITY_STATUSES = ["active", "limited"] as const;

/** 批次门禁入参（04B connector 调用时同样传这三项） */
export interface IngestGateInput {
  source_id: string;
  city_code: string;
  object_level: string;
}

interface LicenseRow {
  status: string;
  valid_until: string | null;
}

/** UTC 今天（YYYY-MM-DD）：与 SQLite datetime('now') 同为 UTC，日期比较口径一致 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function isApproved(status: string): boolean {
  return (AUTOMATION_ALLOWED_STATUSES as readonly string[]).includes(status);
}

/**
 * 读取来源许可状态（缺 license 行 = 未登记状态，按 discovered 返回 null）。
 * approved_* 且 valid_until 早于今天 → 惰性自动 suspend：
 *   - 更新 source_license_state（status/updated_at）；
 *   - 该来源全部已批准 coverage 行同步 suspended（下一批次随之被拒）；
 *   - Private 库写 audit_logs（action=source.auto_suspend，reason=license_expired）。
 * @returns 许可行；source_id 在 data_sources_public 中不存在时返回 null（由调用方区分 404/403）
 */
export async function resolveLicense(
  env: Env,
  sourceId: string,
): Promise<LicenseRow | null> {
  const row = await env.DB_PUBLIC.prepare(
    `SELECT status, valid_until FROM source_license_state WHERE source_id = ?`,
  )
    .bind(sourceId)
    .first<LicenseRow>();
  if (!row) return null;

  const expired =
    isApproved(row.status) &&
    row.valid_until !== null &&
    row.valid_until < today();
  if (!expired) return row;

  // 惰性过期停用：Public 侧状态与 coverage 一并同步
  await env.DB_PUBLIC.batch([
    env.DB_PUBLIC.prepare(
      `UPDATE source_license_state SET status = 'suspended', updated_at = datetime('now') WHERE source_id = ?`,
    ).bind(sourceId),
    env.DB_PUBLIC.prepare(
      `UPDATE source_city_coverage
         SET authorization_status = 'suspended', last_verified_at = datetime('now')
       WHERE source_id = ?
         AND authorization_status IN ('approved', 'approved_open', 'approved_licensed')`,
    ).bind(sourceId),
  ]);
  // 审计留痕（Private，actor 留空=系统动作；audit_logs.actor_user_id 允许 NULL）
  await env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, 'system', 'source.auto_suspend', 'data_source', ?, 'license_expired')`,
  )
    .bind(crypto.randomUUID(), sourceId)
    .run();

  return { status: "suspended", valid_until: row.valid_until };
}

/**
 * 批次入管线门禁（PRD 04A 验收的唯一裁决点）：
 *  ① source_id 必须在 data_sources_public 中存在 → 否则 404 source_not_found；
 *  ② 许可状态必须是 approved_open/approved_licensed（pending_review/suspended/过期等）
 *     → 否则 403 source_not_approved；
 *  ③ (source_id, city_code, object_level) 必须有已批准的 source_city_coverage 行
 *     → 否则 403 city_coverage_denied（拒绝超范围批次）；
 *  ④ cities.status 必须是 active/limited → 否则 403 city_coverage_denied。
 * 通过时 resolve 返回（不抛错）；任何失败以 AppError 抛出。
 */
export async function assertIngestAllowed(
  env: Env,
  input: IngestGateInput,
): Promise<void> {
  // ① 来源存在
  const source = await env.DB_PUBLIC.prepare(
    `SELECT source_id FROM data_sources_public WHERE source_id = ?`,
  )
    .bind(input.source_id)
    .first();
  if (!source) throw errors.sourceNotFound();

  // ② 许可状态（含惰性过期自动 suspend 副作用）
  const license = await resolveLicense(env, input.source_id);
  const status = license?.status ?? "discovered";
  if (!isApproved(status)) {
    throw errors.sourceNotApproved(
      `数据源当前状态不允许自动采集（status=${status}）`,
    );
  }

  // ③ 覆盖白名单：城市 + 对象层级 + 授权状态必须命中
  const coverage = await env.DB_PUBLIC.prepare(
    `SELECT authorization_status FROM source_city_coverage
     WHERE source_id = ? AND city_code = ? AND object_level = ?`,
  )
    .bind(input.source_id, input.city_code, input.object_level)
    .first<{ authorization_status: string }>();
  if (
    !coverage ||
    !(APPROVED_COVERAGE_STATUSES as readonly string[]).includes(
      coverage.authorization_status,
    )
  ) {
    throw errors.cityCoverageDenied(
      "数据源授权覆盖不含该城市/对象层级，或覆盖授权未批准",
    );
  }

  // ④ 城市房价数据状态（目录可检索 ≠ 可自动采集）
  const city = await env.DB_PUBLIC.prepare(
    `SELECT status FROM cities WHERE city_code = ?`,
  )
    .bind(input.city_code)
    .first<{ status: string }>();
  if (
    !city ||
    !(AUTOMATION_CITY_STATUSES as readonly string[]).includes(city.status)
  ) {
    throw errors.cityCoverageDenied(
      "目标城市未开通自动价格采集（status 非 active/limited）",
    );
  }
}

/** 供 admin 列表复用：取状态（缺行按 discovered）并先执行惰性过期处理 */
export async function adminLicenseOf(
  env: Env,
  sourceId: string,
): Promise<{ status: SourceStatus; valid_until: string | null }> {
  const row = await resolveLicense(env, sourceId);
  return {
    status: (row?.status ?? "discovered") as SourceStatus,
    valid_until: row?.valid_until ?? null,
  };
}
