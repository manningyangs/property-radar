// TASK-05B：邮件共享总帽核验（PRD §7.1/§8.8/§11.2——80 封/滚动24h 硬帽、OTP 预留 60）。
// OTP 路径（routes/auth.ts）与通知路径（events/digest）共用本口径：达限即停止调用邮件商，
// 绝不自动切换付费服务；账本只计 status='sent' 的收件人数，失败/达限记录不占额度。
import type { D1Database } from "@cloudflare/workers-types";
import { envInt, type Env } from "../env";

export interface QuotaUsage {
  /** 滚动 24 小时全部 sent 收件人数（含 OTP 与通知） */
  total: number;
  /** 其中 OTP 模板的 sent 数（预留 60 用） */
  otp: number;
  /** 其中通知模板（price_alert/daily_digest）的 sent 数 */
  notify: number;
}

/** 邮件配额账本（滚动 24 小时已发送收件人数，PRD §7.1 免费额度降级） */
export async function emailQuotaUsed(db: D1Database): Promise<QuotaUsage> {
  const row = await db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'sent' THEN recipient_count END), 0) AS total,
         COALESCE(SUM(CASE WHEN status = 'sent' AND template = 'otp' THEN recipient_count END), 0) AS otp,
         COALESCE(SUM(CASE WHEN status = 'sent' AND template != 'otp' THEN recipient_count END), 0) AS notify
       FROM email_send_ledger
       WHERE created_at > datetime('now', '-24 hours')`,
    )
    .first<QuotaUsage>();
  return {
    total: row?.total ?? 0,
    otp: row?.otp ?? 0,
    notify: row?.notify ?? 0,
  };
}

/**
 * 通知侧（事件邮件/每日摘要）是否已达共享总帽（05B 拍板 3）：
 * 总帽 80/24h 达限，或通知侧已用量 ≥ 总帽 − OTP 预留（保 OTP 可用额度）。
 * 达限 → 调用方写 quota_deferred/quota_blocked 并跳过 provider。
 */
export function notificationQuotaExceeded(
  env: Env,
  usage: QuotaUsage,
): boolean {
  const totalCap = envInt(env.EMAIL_DAILY_HARD_CAP, 80);
  const otpCap = envInt(env.OTP_DAILY_RESERVED_CAP, 60);
  const notifyCap = Math.max(0, totalCap - otpCap);
  return usage.total >= totalCap || usage.notify >= notifyCap;
}
