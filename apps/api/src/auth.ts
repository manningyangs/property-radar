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
  user_id: string;
}

/**
 * 强制登录：无 cookie / 无效 / 过期 / 已撤销 → 401 unauthorized。
 * 通过后 c.get("userId") 可用；所有 user-owned 查询必须再按 user_id 过滤。
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) throw errors.unauthorized();
  const tokenHash = await sha256Hex(token);
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT s.user_id FROM sessions s
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
  await next();
};
