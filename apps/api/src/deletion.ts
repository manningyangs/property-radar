// TASK-07B：注销冷静期到期硬删（spec 2.2）。
// 语义：/me/delete-account 标记 status='deletion_pending' 并即时吊销全部会话；
// 7 天内重新登录撤销（auth.ts）；到期由本模块删除该用户全部个人数据。
// 保留：audit_logs（0001 注释——actor 不设外键即为用户注销后日志仍完整）、
// email_send_ledger（无 PII 列）、ingest_*（系统级采集数据，非个人数据）。
import type { D1Database } from "@cloudflare/workers-types";

/** 注销冷静期天数（隐私政策与响应体共用同一真源） */
export const DELETION_COOLDOWN_DAYS = 7;

interface DueUser {
  user_id: string;
  email_normalized: string;
}

/**
 * 删除已过冷静期的注销申请用户。
 * 显式逐表删除（不依赖 D1 会话级 PRAGMA foreign_keys），
 * 顺序：投递 → 事件 → 分组/规则设置 → 规则 → 监控对象 → 其余 user-owned →
 * 管理员残留（角色已撤销的密钥/角色行）→ 会话 → OTP → 用户行。
 */
export async function purgeExpiredDeletions(
  db: D1Database,
): Promise<{ purged: number }> {
  const due = await db
    .prepare(
      `SELECT user_id, email_normalized FROM users
       WHERE status = 'deletion_pending'
         AND deletion_requested_at IS NOT NULL
         AND deletion_requested_at < datetime('now', ?)`,
    )
    .bind(`-${DELETION_COOLDOWN_DAYS} days`)
    .all<DueUser>();

  for (const u of due.results) {
    const del = (sql: string, ...binds: string[]) =>
      db
        .prepare(sql)
        .bind(...binds)
        .run();
    await del(
      "DELETE FROM notification_deliveries WHERE user_id = ?",
      u.user_id,
    );
    await del("DELETE FROM alert_events WHERE user_id = ?", u.user_id);
    await del("DELETE FROM watch_item_groups WHERE user_id = ?", u.user_id);
    await del("DELETE FROM watch_rule_settings WHERE user_id = ?", u.user_id);
    await del("DELETE FROM watch_rules WHERE user_id = ?", u.user_id);
    await del("DELETE FROM watch_items WHERE user_id = ?", u.user_id);
    await del(
      "DELETE FROM notification_preferences WHERE user_id = ?",
      u.user_id,
    );
    await del("DELETE FROM push_subscriptions WHERE user_id = ?", u.user_id);
    await del("DELETE FROM user_consents WHERE user_id = ?", u.user_id);
    await del(
      "DELETE FROM city_coverage_requests WHERE user_id = ?",
      u.user_id,
    );
    await del("DELETE FROM user_cities WHERE user_id = ?", u.user_id);
    await del("DELETE FROM sessions WHERE user_id = ?", u.user_id);
    // 管理员残留：撤销角色后注销的账号，密钥/角色行随用户一并清除
    await del("DELETE FROM admin_mfa_sessions WHERE user_id = ?", u.user_id);
    await del("DELETE FROM admin_mfa_secrets WHERE user_id = ?", u.user_id);
    await del("DELETE FROM admin_roles WHERE user_id = ?", u.user_id);
    // OTP 按邮箱维度（无 user_id 外键，登录前即可存在）
    await del(
      "DELETE FROM email_otps WHERE email_normalized = ?",
      u.email_normalized,
    );
    await del("DELETE FROM users WHERE user_id = ?", u.user_id);
  }
  return { purged: due.results.length };
}
