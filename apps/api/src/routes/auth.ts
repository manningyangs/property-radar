// TASK-02B：认证 API 框架（PRD §10.2）。OTP 请求/校验与会话签发在 TASK-02C 实现。
import { Hono } from "hono";
import { requireSession } from "../auth";
import { type AppEnv } from "../env";

export const authRoutes = new Hono<AppEnv>();

// GET /auth/me —— 当前用户资料（需有效会话，否则 401）
authRoutes.get("/me", requireSession, async (c) => {
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT user_id, email_normalized AS email, status, email_verified_at, created_at, last_login_at
     FROM users WHERE user_id = ?`,
  )
    .bind(c.get("userId"))
    .first();
  return c.json({ user: row });
});
