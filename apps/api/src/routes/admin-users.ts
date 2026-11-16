// TASK-06B：系统总览和用户管理（PRD 任务行 1354–1360 / §8.2 / §8.3 / §10.5）
// 端点：GET /admin/overview（聚合统计，零 PII）、GET /admin/users（脱敏列表）、
//       PATCH /admin/users/:id/status（冻结/解冻，禁自冻结）、
//       GET /admin/users/:id/monitoring（个人监控明细：reason 必填 + 强制审计）。
// 隐私边界（任务书边界条款）：邮箱一律脱敏（de***@domain）；target_value 等个人预算
//       仅 monitoring 端点返回；overview 只出聚合数。
// 冻结政策（拍板 2）：冻结即时阻断登录/新建（requireSession 查 status），
//       停新事件与邮件（rules-engine/digest/events 过滤），既有数据全部保留，解冻即恢复。
import { Hono, type Context } from "hono";
import { requireAdminAccess } from "../auth";
import { errors } from "../errors";
import { type AppEnv } from "../env";
import { readJsonBody, validateOrThrow } from "../validation";
import { patchUserStatusSchema } from "../schemas";

export const adminUsersRoutes = new Hono<AppEnv>();

adminUsersRoutes.use("*", requireAdminAccess);

const USER_STATUSES = new Set(["active", "frozen"]);

/** 邮箱脱敏：local 前 2 字符 + ***（local ≤2 保留首字符）；域名完整保留 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  const local = at >= 0 ? email.slice(0, at) : email;
  const domain = at >= 0 ? email.slice(at) : "";
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${domain}`;
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  return readJsonBody(c.req.header("content-type"), () => c.req.text());
}

/** 整数查询参数（越界/非法 → 400 validation，与 audit 端点手工解析同风格） */
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

/** 用户列表/明细共用的单用户行（明文 email 只在此内部流转，出口必脱敏） */
interface UserRow {
  user_id: string;
  email_normalized: string;
  status: string;
  email_verified_at: string | null;
  created_at: string;
  last_login_at: string | null;
  deleted_at: string | null;
}

async function loadUser(c: Context<AppEnv>, userId: string): Promise<UserRow> {
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT user_id, email_normalized, status, email_verified_at,
            created_at, last_login_at, deleted_at
     FROM users WHERE user_id = ? LIMIT 1`,
  )
    .bind(userId)
    .first<UserRow>();
  if (!row || row.deleted_at !== null) throw errors.notFound("用户不存在");
  return row;
}

/** 列表 item 形态（§8.3：账户状态 + 用户总监控数聚合，不含监控内容） */
async function userItem(c: Context<AppEnv>, row: UserRow) {
  const [admin, watch] = await Promise.all([
    c.env.DB_PRIVATE.prepare(
      "SELECT COUNT(*) AS n FROM admin_roles WHERE user_id = ? AND revoked_at IS NULL",
    )
      .bind(row.user_id)
      .first<{ n: number }>(),
    c.env.DB_PRIVATE.prepare(
      "SELECT COUNT(*) AS n FROM watch_items WHERE user_id = ? AND status = 'active'",
    )
      .bind(row.user_id)
      .first<{ n: number }>(),
  ]);
  return {
    user_id: row.user_id,
    email_masked: maskEmail(row.email_normalized),
    status: row.status,
    email_verified: row.email_verified_at !== null,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    is_admin: (admin?.n ?? 0) > 0,
    watch_count: watch?.n ?? 0,
  };
}

/** 返回预编译语句：可进 batch，或单用 .run() */
function writeAudit(
  c: Context<AppEnv>,
  action: string,
  resourceId: string,
  reason: string,
) {
  return c.env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, ?, 'admin', ?, 'user', ?, ?)`,
  ).bind(crypto.randomUUID(), c.get("userId"), action, resourceId, reason);
}

// ---------------- GET /admin/users：用户列表（脱敏 + 筛选 + 分页） ----------------
adminUsersRoutes.get("/users", async (c) => {
  const q = c.req.query("q")?.trim() ?? "";
  const statusQ = c.req.query("status")?.trim() ?? "";
  const limit = intQuery(c.req.query("limit"), "limit", 20, 1, 100);
  const offset = intQuery(c.req.query("offset"), "offset", 0, 0, 1_000_000);
  if (statusQ !== "" && !USER_STATUSES.has(statusQ)) {
    throw errors.validation([
      { field: "/status", message: "必须是 active 或 frozen" },
    ]);
  }

  const where = ["u.deleted_at IS NULL"];
  const bind: string[] = [];
  if (statusQ !== "") {
    where.push("u.status = ?");
    bind.push(statusQ);
  }
  // q：user_id 精确 或 完整邮箱规范化精确（不做 LIKE，避免枚举放大）
  if (q !== "") {
    where.push("(u.user_id = ? OR u.email_normalized = ?)");
    bind.push(q, q.toLowerCase());
  }
  const whereSql = where.join(" AND ");

  const [countRow, listRes] = await Promise.all([
    c.env.DB_PRIVATE.prepare(
      `SELECT COUNT(*) AS n FROM users u WHERE ${whereSql}`,
    )
      .bind(...bind)
      .first<{ n: number }>(),
    c.env.DB_PRIVATE.prepare(
      `SELECT u.user_id, u.email_normalized, u.status, u.email_verified_at,
              u.created_at, u.last_login_at, u.deleted_at,
              (SELECT COUNT(*) FROM watch_items w
                WHERE w.user_id = u.user_id AND w.status = 'active') AS watch_count,
              (SELECT COUNT(*) FROM admin_roles a
                WHERE a.user_id = u.user_id AND a.revoked_at IS NULL) AS admin_count
       FROM users u WHERE ${whereSql}
       ORDER BY u.created_at DESC, u.user_id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...bind, limit, offset)
      .all<UserRow & { watch_count: number; admin_count: number }>(),
  ]);

  const items = listRes.results.map((row) => ({
    user_id: row.user_id,
    email_masked: maskEmail(row.email_normalized),
    status: row.status,
    email_verified: row.email_verified_at !== null,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    is_admin: row.admin_count > 0,
    watch_count: row.watch_count,
  }));
  return c.json({ items, total: countRow?.n ?? 0, limit, offset });
});

// ---------------- GET /admin/overview：聚合统计（§8.2 前 7 项，零 PII） ----------------
adminUsersRoutes.get("/overview", async (c) => {
  const priv = c.env.DB_PRIVATE;
  const pub = c.env.DB_PUBLIC;
  const [
    usersRow,
    watchRes,
    rulesRow,
    eventsRow,
    emailRow,
    jobsRes,
    sourcesRes,
    snapRow,
  ] = await Promise.all([
    priv
      .prepare(
        `SELECT COUNT(*) AS total,
                  SUM(status = 'active') AS active,
                  SUM(status = 'frozen') AS frozen,
                  SUM(created_at >= datetime('now', '-7 day')) AS new_7d,
                  SUM(last_login_at IS NOT NULL
                      AND last_login_at >= datetime('now', '-7 day')) AS active_7d
           FROM users WHERE deleted_at IS NULL`,
      )
      .first<{
        total: number;
        active: number;
        frozen: number;
        new_7d: number;
        active_7d: number;
      }>(),
    priv
      .prepare(
        `SELECT w.object_type, COUNT(*) AS n
           FROM watch_items w
           JOIN users u ON u.user_id = w.user_id
           WHERE w.status = 'active' AND u.status = 'active' AND u.deleted_at IS NULL
           GROUP BY w.object_type`,
      )
      .all<{ object_type: string; n: number }>(),
    priv
      .prepare(
        `SELECT COUNT(*) AS n
           FROM watch_rules r
           JOIN watch_items w ON w.watch_id = r.watch_id
           JOIN users u ON u.user_id = r.user_id
           WHERE r.is_enabled = 1 AND w.status = 'active'
             AND u.status = 'active' AND u.deleted_at IS NULL`,
      )
      .first<{ n: number }>(),
    priv
      .prepare(
        `SELECT COUNT(*) AS last_7d,
                  SUM(date(created_at) = date('now')) AS today
           FROM alert_events
           WHERE created_at >= datetime('now', '-7 day')`,
      )
      .first<{ last_7d: number; today: number }>(),
    priv
      .prepare(
        `SELECT SUM(status = 'sent') AS sent,
                  SUM(status = 'provider_error') AS provider_error,
                  SUM(status = 'quota_deferred') AS quota_deferred
           FROM notification_deliveries
           WHERE channel = 'email' AND created_at >= datetime('now', '-7 day')`,
      )
      .first<{
        sent: number | null;
        provider_error: number | null;
        quota_deferred: number | null;
      }>(),
    priv
      .prepare(
        `SELECT status, COUNT(*) AS n
           FROM ingest_jobs
           WHERE date(started_at) = date('now')
           GROUP BY status`,
      )
      .all<{ status: string; n: number }>(),
    pub
      .prepare(
        "SELECT status, COUNT(*) AS n FROM source_license_state GROUP BY status",
      )
      .all<{ status: string; n: number }>(),
    pub
      .prepare(
        `SELECT COUNT(*) AS n FROM price_snapshots
           WHERE date(collected_at) = date('now') AND quality_status = 'valid'`,
      )
      .first<{ n: number }>(),
  ]);

  const byObjectType: Record<string, number> = {
    region: 0,
    community: 0,
    listing: 0,
  };
  let watchesActive = 0;
  for (const row of watchRes.results) {
    byObjectType[row.object_type] = row.n;
    watchesActive += row.n;
  }
  const jobsToday: Record<string, number> = {
    succeeded: 0,
    failed: 0,
    running: 0,
  };
  for (const row of jobsRes.results) jobsToday[row.status] = row.n;
  const sourcesByStatus: Record<string, number> = {};
  for (const row of sourcesRes.results) sourcesByStatus[row.status] = row.n;

  const sent = emailRow?.sent ?? 0;
  const providerError = emailRow?.provider_error ?? 0;
  const denom = sent + providerError;

  return c.json({
    users: {
      total: usersRow?.total ?? 0,
      active: usersRow?.active ?? 0,
      frozen: usersRow?.frozen ?? 0,
      new_7d: usersRow?.new_7d ?? 0,
      active_7d: usersRow?.active_7d ?? 0,
    },
    monitoring: {
      watches_active: watchesActive,
      by_object_type: byObjectType,
      rules_enabled: rulesRow?.n ?? 0,
    },
    events: { today: eventsRow?.today ?? 0, last_7d: eventsRow?.last_7d ?? 0 },
    email: {
      last_7d: {
        sent,
        provider_error: providerError,
        quota_deferred: emailRow?.quota_deferred ?? 0,
        success_rate: denom === 0 ? null : Number((sent / denom).toFixed(4)),
      },
    },
    sources: { by_status: sourcesByStatus },
    jobs: { today: jobsToday },
    snapshots: { today_valid: snapRow?.n ?? 0 },
  });
});

// ---------------- PATCH /admin/users/:id/status：冻结/解冻 ----------------
adminUsersRoutes.patch("/users/:id/status", async (c) => {
  const targetId = c.req.param("id");
  const row = await loadUser(c, targetId);

  const body = await jsonBody(c);
  // 规范化先于校验（惯例）：reason 去首尾空格
  if (
    body &&
    typeof body === "object" &&
    typeof (body as { reason?: unknown }).reason === "string"
  ) {
    (body as { reason: string }).reason = (
      body as { reason: string }
    ).reason.trim();
  }
  validateOrThrow(patchUserStatusSchema, body);
  const { status, reason } = body as { status: string; reason: string };

  // 防自锁：管理员不能冻结自己（拍板 1）
  if (status === "frozen" && c.get("userId") === targetId) {
    throw errors.conflict("不能冻结自己的账号");
  }
  if (status === row.status) {
    throw errors.conflict(`当前状态已是 ${row.status}`);
  }

  await c.env.DB_PRIVATE.batch([
    c.env.DB_PRIVATE.prepare(
      "UPDATE users SET status = ? WHERE user_id = ?",
    ).bind(status, targetId),
    writeAudit(
      c,
      "admin.user.status",
      targetId,
      `${row.status}→${status}｜${reason}`,
    ),
  ]);
  return c.json({ user: await userItem(c, { ...row, status }) });
});

// ---------------- GET /admin/users/:id/monitoring：个人监控明细（有理由 + 审计） ----------------
adminUsersRoutes.get("/users/:id/monitoring", async (c) => {
  const targetId = c.req.param("id");
  const reason = c.req.query("reason")?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    throw errors.validation([
      {
        field: "/reason",
        message: "查看个人监控明细必须提供 10–500 字符的理由",
      },
    ]);
  }
  const row = await loadUser(c, targetId);

  const watches = await c.env.DB_PRIVATE.prepare(
    `SELECT watch_id, object_type, object_id, display_name_snapshot,
            priority, status, created_at
     FROM watch_items WHERE user_id = ? ORDER BY created_at DESC, watch_id`,
  )
    .bind(targetId)
    .all<{
      watch_id: string;
      object_type: string;
      object_id: string;
      display_name_snapshot: string;
      priority: number;
      status: string;
      created_at: string;
    }>();
  const watchIds = watches.results.map((w) => w.watch_id);
  const rules =
    watchIds.length === 0
      ? { results: [] as RuleDetailRow[] }
      : await c.env.DB_PRIVATE.prepare(
          `SELECT rule_id, watch_id, rule_type, metric_code, price_type,
                  target_value, currency, unit, window_days, threshold_pct,
                  is_enabled, armed_state
           FROM watch_rules
           WHERE watch_id IN (${watchIds.map(() => "?").join(", ")})
           ORDER BY created_at DESC, rule_id`,
        )
          .bind(...watchIds)
          .all<RuleDetailRow>();

  const byWatch = new Map<string, RuleDetailRow[]>();
  for (const r of rules.results) {
    const arr = byWatch.get(r.watch_id) ?? [];
    arr.push(r);
    byWatch.set(r.watch_id, arr);
  }

  // 审计先落行再响应（任务书边界：查看个人监控明细要有理由并审计）
  await writeAudit(c, "admin.user.monitoring_view", targetId, reason).run();

  return c.json({
    user: {
      user_id: row.user_id,
      email_masked: maskEmail(row.email_normalized),
      status: row.status,
      created_at: row.created_at,
      last_login_at: row.last_login_at,
    },
    watches: watches.results.map((w) => ({
      ...w,
      rules: (byWatch.get(w.watch_id) ?? []).map((r) => ({ ...r })),
    })),
    counts: { watches: watches.results.length, rules: rules.results.length },
  });
});

interface RuleDetailRow {
  rule_id: string;
  watch_id: string;
  rule_type: string;
  metric_code: string;
  price_type: string | null;
  target_value: number | null;
  currency: string;
  unit: string | null;
  window_days: number | null;
  threshold_pct: number | null;
  is_enabled: number;
  armed_state: string;
}
