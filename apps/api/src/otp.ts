// TASK-02C：邮箱 OTP——生成、哈希、TTL 与频率/锁定常量（PRD §7.1 OTP 流程）。
// 硬约束：验证码只以 HMAC 哈希入库（email_otps.code_hash），绝不存明文、绝不进日志。
import { hmacSha256Hex } from "./crypto";
import { type D1Database } from "@cloudflare/workers-types";

/** 验证码有效期 10 分钟（PRD §7.1） */
export const OTP_TTL_MINUTES = 10;
/** 同邮箱申请冷却 60 秒（PRD §7.1 步骤 5） */
export const OTP_COOLDOWN_SEC = 60;
/** 同邮箱 / 同 IP 每 15 分钟最多申请次数（PRD §7.1 步骤 3/5） */
export const OTP_WINDOW_MINUTES = 15;
export const OTP_MAX_PER_WINDOW = 5;
/** 单个验证码最多尝试 5 次，超限锁定至其过期（短期窗口，PRD §7.1 步骤 5） */
export const OTP_MAX_ATTEMPTS = 5;
/** 会话有效期 30 天 */
export const SESSION_TTL_DAYS = 30;

/** 邮箱规范化：去空白 + 小写（库内 email_normalized 统一存储） */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 密码学安全六位数字验证码（拒绝采样消除取模偏差） */
export function randomOtpCode(): string {
  const limit = 0x1_0000_0000 - (0x1_0000_0000 % 1_000_000);
  const buf = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buf);
    value = buf[0] ?? 0;
  } while (value >= limit);
  return String(value % 1_000_000).padStart(6, "0");
}

/** 密码学安全会话 token（32 字节 hex，浏览器持 token，库存 sha256 哈希） */
export function randomSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * OTP 码 HMAC 哈希：密钥取 SESSION_SIGNING_SECRET，绑定邮箱与用途，
 * 防止哈希被跨邮箱重放（PRD §7.1 步骤 4「仅存 HMAC/hash」）。
 */
export async function hashOtpCode(
  secret: string,
  emailNormalized: string,
  code: string,
): Promise<string> {
  return hmacSha256Hex(secret, `otp|login|${emailNormalized}|${code}`);
}

/**
 * 请求指纹（IP 维度）哈希：只存哈希，不存原始 IP（PRD §9.2/§12.0 日志脱敏）。
 */
export async function requestFingerprint(
  secret: string,
  ip: string,
): Promise<string> {
  return (await hmacSha256Hex(secret, `otp-ip|${ip}`)).slice(0, 32);
}

/** 过期/已消费超期的验证码自动清理（PRD §7.1 步骤 8） */
export async function cleanupExpiredOtps(db: D1Database): Promise<void> {
  await db
    .prepare(
      `DELETE FROM email_otps
       WHERE expires_at < datetime('now', '-1 day')
          OR consumed_at < datetime('now', '-1 day')`,
    )
    .run();
}
