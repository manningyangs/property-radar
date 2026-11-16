// TASK-02B：会话认证中间件（/me/* 与 /auth/me 强制登录）。
// 会话签发属于 TASK-02C（邮箱 OTP 登录）；本中间件只做「cookie → sessions → user」校验。
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { errors } from "./errors";
import { SESSION_COOKIE, type AppEnv } from "./env";

/** SHA-256 十六进制（浏览器只持随机 token，库存哈希，PRD §9.2） */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface SessionRow {
  session_id: string;
  user_id: string;
}

/**
 * 强制登录：无 cookie / 无效 / 过期 / 已撤销 → 401 unauthorized。
 * 通过后 c.get("userId") 与 c.get("sessionId") 可用；
 * 所有 user-owned 查询必须再按 user_id 过滤。
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw errors.unauthorized();
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT s.session_id, s.user_id FROM sessions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.token_hash = ?
       AND s.expires_at > datetime('now')
       AND s.revoked_at IS NULL
       AND u.deleted_at IS NULL
       AND u.status = 'active'
     LIMIT 1`,
  )
    .bind(tokenHash)
    .first<SessionRow>();
  if (!row) throw errors.unauthorized();
  c.set("userId", row.user_id);
  c.set("sessionId", row.session_id);
  await next();
};

// ==== TASK-06A：后台认证与权限（PRD 任务行 1346–1352 / §8.4） ====

/**
 * 管理员角色门禁：无活跃 admin_roles → 403 admin_required。
 * （04A 内联中间件外提，admin 路由与 admin-auth 路由共用）
 */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const role = await c.env.DB_PRIVATE.prepare(
    "SELECT admin_id FROM admin_roles WHERE user_id = ? AND revoked_at IS NULL LIMIT 1",
  )
    .bind(c.get("userId"))
    .first();
  if (!role) throw errors.adminRequired();
  await next();
};

/**
 * 管理员 MFA 门禁：当前会话未完成 TOTP 二次验证 → 403 mfa_required。
 * 标记按 session 级存 admin_mfa_sessions（FK 级联 sessions），
 * 查询仍复核 sessions 未过期未撤销（防撤销会话残留标记）。
 */
export const requireAdminMfa: MiddlewareHandler<AppEnv> = async (c, next) => {
  const mark = await c.env.DB_PRIVATE.prepare(
    `SELECT m.session_id FROM admin_mfa_sessions m
     JOIN sessions s ON s.session_id = m.session_id
     WHERE m.session_id = ?
       AND s.expires_at > datetime('now')
       AND s.revoked_at IS NULL
     LIMIT 1`,
  )
    .bind(c.get("sessionId"))
    .first();
  if (!mark) throw errors.mfaRequired();
  await next();
};

/** MFA 豁免路径（MFA 流程自身端点；仅需会话 + 管理员角色） */
const MFA_EXEMPT_SUFFIXES = [
  "/admin/mfa/setup",
  "/admin/mfa/verify",
  "/admin/mfa/status",
];

/**
 * /api/v1/admin/* 统一门禁（TASK-06A spec R3）：
 *   bootstrap：无会话/角色要求（首次建管理员前系统内无管理员）；
 *   mfa setup/verify/status：会话 + 角色，豁免 MFA（其自身即 MFA 绑定/验证流程）；
 *   其余全部端点：会话 + 角色 + MFA（session 级标记）。
 * admin-auth 路由另挂显式 per-route 门禁作双保险（跨挂载顺序不依赖）。
 */
export const requireAdminAccess: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const path = c.req.path;
  if (path.endsWith("/admin/bootstrap")) return next();
  await requireSession(c, async () => {
    await requireAdmin(c, async () => {
      if (MFA_EXEMPT_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
        await next();
        return;
      }
      await requireAdminMfa(c, next);
    });
  });
};
