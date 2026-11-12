// TASK-02B/02C：认证 API（PRD §10.2）——邮箱 OTP 请求/校验、会话签发与注销。
// 安全约束（PRD §7.1/§12.0）：
//   1) OTP 只存 HMAC 哈希，TTL 10 分钟、单次使用、5 次尝试锁定；
//   2) 统一响应文案防邮箱枚举（存在与不存在的邮箱返回完全一致）；
//   3) 会话 token 仅经 HttpOnly/Secure/SameSite cookie 下发，库存 sha256 哈希；
//   4) 日志与响应中绝不出现验证码、明文邮箱与 Secret。
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { D1Database } from "@cloudflare/workers-types";
import { requireSession, sha256Hex } from "../auth";
import { timingSafeEqualHex } from "../crypto";
import { errors } from "../errors";
import { envInt, SESSION_COOKIE, type AppEnv, type Env } from "../env";
import { createEmailProvider, EmailProviderError } from "../email/provider";
import {
  cleanupExpiredOtps,
  hashOtpCode,
  normalizeEmail,
  OTP_COOLDOWN_SEC,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_WINDOW,
  OTP_TTL_MINUTES,
  OTP_WINDOW_MINUTES,
  randomOtpCode,
  randomSessionToken,
  requestFingerprint,
  SESSION_TTL_DAYS,
} from "../otp";
import { clientIp } from "../rate-limit";
import { requestCodeSchema, verifyCodeSchema } from "../schemas";
import { verifyTurnstile } from "../turnstile";
import { readJsonBody, validateOrThrow } from "../validation";

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

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  return readJsonBody(c.req.header("content-type"), () => c.req.text());
}

/** 认证所需 Secrets 缺失时 503（不静默降级，PRD §7.6 安全基线） */
function requireSecret(env: Env): string {
  const secret = env.SESSION_SIGNING_SECRET?.trim();
  if (!secret) throw errors.unavailable("登录服务未配置");
  return secret;
}

/** 邮件配额账本（滚动 24 小时已发送收件人数，PRD §7.1 免费额度降级） */
async function emailQuotaUsed(
  db: D1Database,
): Promise<{ total: number; otp: number }> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'sent' THEN recipient_count END), 0) AS total,
         COALESCE(SUM(CASE WHEN status = 'sent' AND template = 'otp' THEN recipient_count END), 0) AS otp
       FROM email_send_ledger
       WHERE created_at > datetime('now', '-24 hours')`,
    )
    .first<{ total: number; otp: number }>();
  return { total: row?.total ?? 0, otp: row?.otp ?? 0 };
}

interface OtpRateRow {
  cooldown: number;
  email_15m: number;
  ip_15m: number;
}

/**
 * 申请频率检查（PRD §7.1 步骤 3/5）：
 * 同邮箱 60 秒冷却；同邮箱、同 IP（指纹哈希）每 15 分钟各最多 5 次。
 * 触发统一 429 rate_limited，不区分邮箱是否存在。
 */
async function assertOtpRate(
  db: D1Database,
  emailNormalized: string,
  fingerprint: string,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM email_otps
           WHERE email_normalized = ?1 AND created_at > datetime('now', ?3)) AS cooldown,
         (SELECT COUNT(*) FROM email_otps
           WHERE email_normalized = ?1 AND created_at > datetime('now', ?4)) AS email_15m,
         (SELECT COUNT(*) FROM email_otps
           WHERE request_fingerprint_hash = ?2 AND created_at > datetime('now', ?4)) AS ip_15m`,
    )
    .bind(
      emailNormalized,
      fingerprint,
      `-${OTP_COOLDOWN_SEC} seconds`,
      `-${OTP_WINDOW_MINUTES} minutes`,
    )
    .first<OtpRateRow>();
  if (
    (row?.cooldown ?? 0) > 0 ||
    (row?.email_15m ?? 0) >= OTP_MAX_PER_WINDOW ||
    (row?.ip_15m ?? 0) >= OTP_MAX_PER_WINDOW
  ) {
    throw errors.rateLimited("请求过于频繁，请稍后重试");
  }
}

// POST /auth/email/request-code —— 请求验证码（统一文案，防邮箱枚举）
authRoutes.post("/email/request-code", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(requestCodeSchema, body);
  const input = body as { email: string; turnstile_token: string };
  const emailNormalized = normalizeEmail(input.email);
  const ip = clientIp((name) => c.req.header(name));
  const secret = requireSecret(c.env);

  // 1) Turnstile 人机校验（PRD §7.1 步骤 2；未配置直接 503）
  const turnstileOk = await verifyTurnstile(c.env, input.turnstile_token, ip);
  if (!turnstileOk) throw errors.badRequest("人机验证未通过，请重试");

  // 2) 邮箱/IP 维度限流（防邮件轰炸）
  const fingerprint = await requestFingerprint(secret, ip);
  await assertOtpRate(c.env.DB_PRIVATE, emailNormalized, fingerprint);

  // 3) 发送配额（达到硬上限即停止调用邮件商，PRD §7.1）
  const quota = await emailQuotaUsed(c.env.DB_PRIVATE);
  const totalCap = envInt(c.env.EMAIL_DAILY_HARD_CAP, 80);
  const otpCap = envInt(c.env.OTP_DAILY_RESERVED_CAP, 60);
  if (quota.total >= totalCap || quota.otp >= otpCap) {
    throw errors.rateLimited("今日邮件额度已用完，请稍后再试");
  }

  // 4) 生成验证码：只存 HMAC 哈希；同邮箱旧码立即作废（单活跃码）
  const code = randomOtpCode();
  const codeHash = await hashOtpCode(secret, emailNormalized, code);
  const otpId = crypto.randomUUID();
  await c.env.DB_PRIVATE.prepare(
    `UPDATE email_otps SET consumed_at = datetime('now')
     WHERE email_normalized = ? AND consumed_at IS NULL`,
  )
    .bind(emailNormalized)
    .run();
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO email_otps
       (otp_id, email_normalized, code_hash, purpose, expires_at, request_fingerprint_hash)
     VALUES (?, ?, ?, 'login', datetime('now', ?), ?)`,
  )
    .bind(
      otpId,
      emailNormalized,
      codeHash,
      `+${OTP_TTL_MINUTES} minutes`,
      fingerprint,
    )
    .run();
  await cleanupExpiredOtps(c.env.DB_PRIVATE);

  // 5) 调用邮件网关（认证业务只依赖 EmailProvider 接口）
  const provider = createEmailProvider(c.env);
  try {
    await provider.sendOtp({
      to: emailNormalized,
      code,
      ttlMinutes: OTP_TTL_MINUTES,
    });
  } catch (e) {
    // 发送失败：作废本次 OTP（码从未送达），返回统一的暂不可用文案
    await c.env.DB_PRIVATE.prepare("DELETE FROM email_otps WHERE otp_id = ?")
      .bind(otpId)
      .run();
    if (e instanceof EmailProviderError) {
      throw errors.unavailable("邮件发送暂不可用，请稍后再试");
    }
    throw e;
  }

  // 6) 记录配额账本（滚动 24 小时，二次核验依据）
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO email_send_ledger
       (ledger_id, template, recipient_count, provider, status, request_id)
     VALUES (?, 'otp', 1, ?, 'sent', ?)`,
  )
    .bind(crypto.randomUUID(), provider.name, c.get("requestId"))
    .run();

  // 统一响应（无论邮箱是否存在，文案完全一致，防枚举）
  return c.json({
    status: "ok",
    message: "如果该邮箱可用，验证码已发送，10 分钟内有效。",
  });
});

interface OtpVerifyRow {
  otp_id: string;
  code_hash: string;
  attempt_count: number;
}

// POST /auth/email/verify-code —— 校验验证码并创建会话（单次使用）
authRoutes.post("/email/verify-code", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(verifyCodeSchema, body);
  const input = body as { email: string; code: string };
  const emailNormalized = normalizeEmail(input.email);
  const secret = requireSecret(c.env);

  const otp = await c.env.DB_PRIVATE.prepare(
    `SELECT otp_id, code_hash, attempt_count FROM email_otps
     WHERE email_normalized = ? AND purpose = 'login'
       AND consumed_at IS NULL AND expires_at > datetime('now')
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(emailNormalized)
    .first<OtpVerifyRow>();
  // 不存在/已过期/已消费：与错误码同文案（防枚举 + 防探测）
  if (!otp) throw errors.unauthorized("验证码无效或已过期");
  // 5 次失败后锁定至该码过期（短期窗口，PRD §7.1 步骤 5）
  if (otp.attempt_count >= OTP_MAX_ATTEMPTS) {
    throw errors.rateLimited("尝试次数过多，请稍后重新获取验证码");
  }

  const providedHash = await hashOtpCode(secret, emailNormalized, input.code);
  if (!timingSafeEqualHex(providedHash, otp.code_hash)) {
    await c.env.DB_PRIVATE.prepare(
      "UPDATE email_otps SET attempt_count = attempt_count + 1 WHERE otp_id = ?",
    )
      .bind(otp.otp_id)
      .run();
    throw errors.unauthorized("验证码无效或已过期");
  }

  // 单次消费：原子 UPDATE，防并发重放（changes=0 表示已被消费）
  const consumed = await c.env.DB_PRIVATE.prepare(
    `UPDATE email_otps SET consumed_at = datetime('now')
     WHERE otp_id = ? AND consumed_at IS NULL`,
  )
    .bind(otp.otp_id)
    .run();
  if ((consumed.meta.changes ?? 0) === 0) {
    throw errors.unauthorized("验证码无效或已过期");
  }

  // 找到或创建用户（登录即注册，PRD US-03；验证成功后才创建，防枚举探测）
  let user = await c.env.DB_PRIVATE.prepare(
    `SELECT user_id, status, deleted_at FROM users WHERE email_normalized = ?`,
  )
    .bind(emailNormalized)
    .first<{ user_id: string; status: string; deleted_at: string | null }>();
  if (user && (user.deleted_at || user.status !== "active")) {
    throw errors.unauthorized("账号不可用");
  }
  if (!user) {
    const userId = crypto.randomUUID();
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO users (user_id, email_normalized, email_verified_at, last_login_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    )
      .bind(userId, emailNormalized)
      .run();
    user = { user_id: userId, status: "active", deleted_at: null };
  } else {
    await c.env.DB_PRIVATE.prepare(
      `UPDATE users
       SET last_login_at = datetime('now'),
           email_verified_at = COALESCE(email_verified_at, datetime('now'))
       WHERE user_id = ?`,
    )
      .bind(user.user_id)
      .run();
  }

  // 会话签发：浏览器只持随机 token，库存 sha256 哈希（PRD §9.2 sessions）
  const token = randomSessionToken();
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, datetime('now', ?))`,
  )
    .bind(
      crypto.randomUUID(),
      user.user_id,
      await sha256Hex(token),
      `+${SESSION_TTL_DAYS} days`,
    )
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });

  return c.json({
    user: {
      user_id: user.user_id,
      email: emailNormalized,
      status: "active",
    },
  });
});

// POST /auth/logout —— 撤销当前会话并清除 cookie（幂等，无会话也返回成功）
authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await c.env.DB_PRIVATE.prepare(
      `UPDATE sessions SET revoked_at = COALESCE(revoked_at, datetime('now'))
       WHERE token_hash = ?`,
    )
      .bind(await sha256Hex(token))
      .run();
  }
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ logged_out: true });
});
