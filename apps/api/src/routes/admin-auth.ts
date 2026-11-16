// TASK-06A：后台认证与权限（PRD 任务行 1346–1352 / §10.5 / §8.4 管理员安全）
// 端点：POST /admin/bootstrap（首次创建管理员）、POST /admin/mfa/{setup,verify,disable}、
//       GET /admin/mfa/status、GET /admin/audit（分页 + 筛选）。
// 门禁：各路由显式挂 requireSession/requireAdmin/requireAdminMfa（双保险——
//       与 app 顶层 adminRoutes.use("*", requireAdminAccess) 的豁免规则一致，不依赖挂载顺序）。
// MFA：TOTP RFC 6238（../totp）；verify 校验通过步进 > last_used_step 才放行（防重放）；
//      成功后写 admin_mfa_sessions（session 级标记，新登录会话需重新验证）。
import { Hono, type Context } from "hono";
import { requireAdmin, requireAdminMfa, requireSession } from "../auth";
import { errors } from "../errors";
import { type AppEnv } from "../env";
import { readJsonBody, validateOrThrow } from "../validation";
import { bootstrapAdminSchema, mfaCodeSchema } from "../schemas";
import { generateTotpSecret, otpauthUri, verify } from "../totp";

export const adminAuthRoutes = new Hono<AppEnv>();

/** 常量时间字符串比较（bootstrap code；长度差异不提前返回） */
function safeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  return readJsonBody(c.req.header("content-type"), () => c.req.text());
}

function writeAudit(
  c: Context<AppEnv>,
  action: string,
  actorUserId: string,
  resourceId: string | null,
  reason: string,
) {
  return c.env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, ?, 'admin', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actorUserId,
      action,
      "admin_auth",
      resourceId,
      reason,
    )
    .run();
}

// ---------------- POST /admin/bootstrap：首次创建管理员 ----------------
// 无会话要求（系统尚无管理员时无人能登录后台）；ADMIN_BOOTSTRAP_CODE 未配置 → 503 禁用。
adminAuthRoutes.post("/bootstrap", async (c) => {
  const configured = c.env.ADMIN_BOOTSTRAP_CODE;
  if (!configured) throw errors.bootstrapNotConfigured();
  const body = await jsonBody(c);
  // 规范化（去首尾空格）先于校验——EMAIL_PATTERN 禁止空白字符
  if (
    body &&
    typeof body === "object" &&
    typeof (body as { email?: unknown }).email === "string"
  ) {
    (body as { email: string }).email = (
      body as { email: string }
    ).email.trim();
  }
  validateOrThrow(bootstrapAdminSchema, body);
  const input = body as { bootstrap_code: string; email: string };
  if (!safeEqual(input.bootstrap_code, configured))
    throw errors.bootstrapCodeInvalid();

  const emailNorm = input.email.toLowerCase();
  const user = await c.env.DB_PRIVATE.prepare(
    "SELECT user_id FROM users WHERE email_normalized = ? AND deleted_at IS NULL LIMIT 1",
  )
    .bind(emailNorm)
    .first<{ user_id: string }>();
  if (!user) throw errors.bootstrapTargetNotFound();

  const existing = await c.env.DB_PRIVATE.prepare(
    "SELECT admin_id FROM admin_roles WHERE user_id = ? AND revoked_at IS NULL LIMIT 1",
  )
    .bind(user.user_id)
    .first<{ admin_id: string }>();
  if (existing) {
    return c.json({
      user_id: user.user_id,
      admin_id: existing.admin_id,
      created: false,
    });
  }

  const adminId = crypto.randomUUID();
  await c.env.DB_PRIVATE.batch([
    c.env.DB_PRIVATE.prepare(
      `INSERT INTO admin_roles (admin_id, user_id, role, mfa_required, created_by)
       VALUES (?, ?, 'admin', 1, 'bootstrap')`,
    ).bind(adminId, user.user_id),
    // 审计：actor = 被提升用户（bootstrap 无会话方）；resource = admin_roles 行
    c.env.DB_PRIVATE.prepare(
      `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
       VALUES (?, ?, 'admin', 'admin.bootstrap', 'admin_role', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      user.user_id,
      adminId,
      "ADMIN_BOOTSTRAP_CODE 创建管理员；代码应立即撤销",
    ),
  ]);
  return c.json(
    {
      user_id: user.user_id,
      admin_id: adminId,
      created: true,
      notice: "管理员已创建；请立即撤销/删除 ADMIN_BOOTSTRAP_CODE 配置",
    },
    201,
  );
});

// ---------------- POST /admin/mfa/setup：生成 TOTP 密钥 ----------------
// 门禁：会话 + 角色，豁免 MFA（MFA 流程自身）；已确认绑定 → 409（先 disable 再重绑）。
adminAuthRoutes.post("/mfa/setup", requireSession, requireAdmin, async (c) => {
  const userId = c.get("userId");
  const existing = await c.env.DB_PRIVATE.prepare(
    "SELECT secret_base32, confirmed_at FROM admin_mfa_secrets WHERE user_id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ secret_base32: string; confirmed_at: string | null }>();
  if (existing?.confirmed_at) throw errors.mfaConflict();

  const secret = generateTotpSecret();
  if (existing) {
    await c.env.DB_PRIVATE.prepare(
      `UPDATE admin_mfa_secrets
       SET secret_base32 = ?, confirmed_at = NULL, last_used_step = NULL, created_at = datetime('now')
       WHERE user_id = ?`,
    )
      .bind(secret, userId)
      .run();
  } else {
    await c.env.DB_PRIVATE.prepare(
      "INSERT INTO admin_mfa_secrets (user_id, secret_base32) VALUES (?, ?)",
    )
      .bind(userId, secret)
      .run();
  }
  await writeAudit(
    c,
    "admin.mfa.setup",
    userId,
    userId,
    "生成 TOTP 密钥（待验证确认）",
  );

  const account = await c.env.DB_PRIVATE.prepare(
    "SELECT email_normalized FROM users WHERE user_id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ email_normalized: string }>();
  return c.json({
    secret,
    otpauth_uri: otpauthUri(secret, account?.email_normalized ?? "admin"),
  });
});

// ---------------- POST /admin/mfa/verify：验证并标记当前会话 ----------------
adminAuthRoutes.post("/mfa/verify", requireSession, requireAdmin, async (c) => {
  const userId = c.get("userId");
  const sessionId = c.get("sessionId");
  const body = await jsonBody(c);
  validateOrThrow(mfaCodeSchema, body);
  const { code } = body as { code: string };

  const row = await c.env.DB_PRIVATE.prepare(
    "SELECT secret_base32, last_used_step FROM admin_mfa_secrets WHERE user_id = ? LIMIT 1",
  )
    .bind(userId)
    .first<{ secret_base32: string; last_used_step: number | null }>();
  if (!row) throw errors.mfaNotEnrolled();

  const result = await verify(row.secret_base32, code);
  // 防重放：步进 ≤ 上次已用步进 = 同码重用，与错码同判 400
  if (!result.ok || (result.step ?? -1) <= (row.last_used_step ?? -1))
    throw errors.mfaInvalidCode(
      result.ok ? "验证码已使用，请等待下一个时间步" : "验证码错误或已过期",
    );

  await c.env.DB_PRIVATE.batch([
    c.env.DB_PRIVATE.prepare(
      `UPDATE admin_mfa_secrets
       SET confirmed_at = COALESCE(confirmed_at, datetime('now')), last_used_step = ?
       WHERE user_id = ?`,
    ).bind(result.step, userId),
    c.env.DB_PRIVATE.prepare(
      `INSERT INTO admin_mfa_sessions (session_id, user_id, verified_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (session_id) DO UPDATE SET verified_at = datetime('now')`,
    ).bind(sessionId, userId),
    c.env.DB_PRIVATE.prepare(
      `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
       VALUES (?, ?, 'admin', 'admin.mfa.verify', 'admin_auth', ?, 'TOTP 验证通过，会话标记 MFA 已验证')`,
    ).bind(crypto.randomUUID(), userId, userId),
  ]);
  return c.json({ verified: true, session_verified: true });
});

// ---------------- POST /admin/mfa/disable：解除绑定（MFA + body code 双确认） ----------------
adminAuthRoutes.post(
  "/mfa/disable",
  requireSession,
  requireAdmin,
  requireAdminMfa,
  async (c) => {
    const userId = c.get("userId");
    const body = await jsonBody(c);
    validateOrThrow(mfaCodeSchema, body);
    const { code } = body as { code: string };

    const row = await c.env.DB_PRIVATE.prepare(
      "SELECT secret_base32, last_used_step FROM admin_mfa_secrets WHERE user_id = ? LIMIT 1",
    )
      .bind(userId)
      .first<{ secret_base32: string; last_used_step: number | null }>();
    if (!row) throw errors.mfaNotEnrolled();
    const result = await verify(row.secret_base32, code);
    if (!result.ok || (result.step ?? -1) <= (row.last_used_step ?? -1))
      throw errors.mfaInvalidCode();

    await c.env.DB_PRIVATE.batch([
      c.env.DB_PRIVATE.prepare(
        "DELETE FROM admin_mfa_secrets WHERE user_id = ?",
      ).bind(userId),
      c.env.DB_PRIVATE.prepare(
        "DELETE FROM admin_mfa_sessions WHERE user_id = ?",
      ).bind(userId),
      c.env.DB_PRIVATE.prepare(
        `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
         VALUES (?, ?, 'admin', 'admin.mfa.disable', 'admin_auth', ?, 'TOTP 双确认后解除绑定并清除全部会话标记')`,
      ).bind(crypto.randomUUID(), userId, userId),
    ]);
    return c.json({ disabled: true });
  },
);

// ---------------- GET /admin/mfa/status：绑定状态（供前端引导） ----------------
adminAuthRoutes.get("/mfa/status", requireSession, requireAdmin, async (c) => {
  const userId = c.get("userId");
  const sessionId = c.get("sessionId");
  const [secretRow, mark] = await Promise.all([
    c.env.DB_PRIVATE.prepare(
      "SELECT confirmed_at FROM admin_mfa_secrets WHERE user_id = ? LIMIT 1",
    )
      .bind(userId)
      .first<{ confirmed_at: string | null }>(),
    c.env.DB_PRIVATE.prepare(
      "SELECT verified_at FROM admin_mfa_sessions WHERE session_id = ? LIMIT 1",
    )
      .bind(sessionId)
      .first<{ verified_at: string }>(),
  ]);
  return c.json({
    enrolled: Boolean(secretRow),
    confirmed: Boolean(secretRow?.confirmed_at),
    session_verified: Boolean(mark),
  });
});

/** audit_logs 查询行（GET /admin/audit） */
interface AuditRow {
  audit_id: string;
  actor_user_id: string;
  actor_role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  reason: string | null;
  created_at: string;
}

// ---------------- GET /admin/audit：审计日志查询（分页 + 精确筛选） ----------------
adminAuthRoutes.get(
  "/audit",
  requireSession,
  requireAdmin,
  requireAdminMfa,
  async (c) => {
    const q = c.req.query();
    const rawLimit = Number.parseInt(q.limit ?? "", 10);
    const rawOffset = Number.parseInt(q.offset ?? "", 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(200, Math.max(1, rawLimit))
      : 50;
    const offset = Number.isFinite(rawOffset) ? Math.max(0, rawOffset) : 0;

    const where: string[] = [];
    const binds: Array<string | number> = [];
    for (const [key, col] of [
      ["action", "action"],
      ["actor_user_id", "actor_user_id"],
      ["resource_type", "resource_type"],
    ] as const) {
      const value = q[key];
      if (value) {
        if (value.length > 64)
          throw errors.validation([
            { field: key, message: "筛选值最长 64 字符" },
          ]);
        where.push(`${col} = ?`);
        binds.push(value);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const count = await c.env.DB_PRIVATE.prepare(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`,
    )
      .bind(...binds)
      .first<{ total: number }>();
    const rows = await c.env.DB_PRIVATE.prepare(
      `SELECT audit_id, actor_user_id, actor_role, action, resource_type,
              resource_id, reason, created_at
       FROM audit_logs ${whereSql}
       ORDER BY created_at DESC, audit_id DESC
       LIMIT ? OFFSET ?`,
    )
      .bind(...binds, limit, offset)
      .all<AuditRow>();
    return c.json({
      items: rows.results,
      total: count?.total ?? 0,
      limit,
      offset,
    });
  },
);
