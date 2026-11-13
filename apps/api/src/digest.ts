// TASK-05B R2/R3：每日摘要（PRD §6.6 07:30 每日生成与失败补偿 / §7.2 摘要内容 / §7.4 默认关）
// 口径（拍板 2/3/4）：全局 cron 北京 07:30（digest_time 存而不生效）；共享 80/24h 总帽；
// 发送失败立即重试 1 次（共 2 次尝试）。仅聚合上一北京日 alert_events；
// digest_enabled=1 且 email 开启才发送；无事件跳过不记账；
// 幂等键 digest:{user_id}:{发件北京日} 落 ledger.request_id（status='sent' 查重，同日复跑零新增）；
// 达限跳过该用户并计 quota_blocked（不调 provider、不记账）。
import { buildDigestMailContent } from "./email/content";
import { createEmailProvider, type DigestMail } from "./email/provider";
import { emailQuotaUsed, notificationQuotaExceeded } from "./email/quota";
import type { Env } from "./env";
import { addDays, shanghaiDate } from "./events";

export interface DigestResult {
  /** 候选用户（digest/email 开启且有账号） */
  candidates: number;
  /** 成功发送 */
  sent: number;
  /** 上一北京日无事件而跳过 */
  skipped_no_events: number;
  /** 同日同用户已 sent（幂等命中） */
  already_sent: number;
  /** 共享总帽达限跳过 */
  quota_blocked: number;
  /** 重试 2 次仍失败 */
  failed: number;
  /** 已发送摘要中聚合的事件数 */
  events_aggregated: number;
}

export interface DigestOptions {
  /** 测试注入发送桩（spec R4.1）；缺省走真实 provider.sendDigest */
  sendMail?: (mail: DigestMail) => Promise<void>;
}

interface CandidateRow {
  user_id: string;
  email_normalized: string;
}

interface DigestEventRow {
  event_type: string;
  status: string;
  evidence_json: string;
}

/** 生成并发送每日摘要（Worker scheduled 调用；单用户失败不中断其余用户） */
export async function sendDailyDigest(
  env: Env,
  now: Date,
  opts: DigestOptions = {},
): Promise<DigestResult> {
  const result: DigestResult = {
    candidates: 0,
    sent: 0,
    skipped_no_events: 0,
    already_sent: 0,
    quota_blocked: 0,
    failed: 0,
    events_aggregated: 0,
  };
  const sendDate = shanghaiDate(now); // 发件北京日（幂等键日期）
  const digestDate = addDays(sendDate, -1); // 摘要覆盖的上一北京日
  const webBase = (env.WEB_BASE_URL ?? "http://localhost:4321").trim();
  const providerName = (env.EMAIL_PROVIDER ?? "google_apps_script_mail").trim();

  const { results: candidates } = await env.DB_PRIVATE.prepare(
    `SELECT p.user_id, u.email_normalized
       FROM notification_preferences p
       JOIN users u ON u.user_id = p.user_id
      WHERE p.digest_enabled = 1 AND p.email_enabled = 1`,
  ).all<CandidateRow>();
  result.candidates = candidates.length;

  for (const user of candidates) {
    const key = `digest:${user.user_id}:${sendDate}`;

    // R2.2 发送幂等：同日同用户已 sent → 跳过
    const dup = await env.DB_PRIVATE.prepare(
      `SELECT 1 FROM email_send_ledger
        WHERE request_id = ? AND status = 'sent' LIMIT 1`,
    )
      .bind(key)
      .first();
    if (dup) {
      result.already_sent += 1;
      continue;
    }

    // R2.1 聚合上一北京日事件；无事件跳过（不发、不记账）
    const { results: events } = await env.DB_PRIVATE.prepare(
      `SELECT event_type, status, evidence_json
         FROM alert_events
        WHERE user_id = ? AND date(created_at, '+8 hours') = ?
        ORDER BY rowid`,
    )
      .bind(user.user_id, digestDate)
      .all<DigestEventRow>();
    if (events.length === 0) {
      result.skipped_no_events += 1;
      continue;
    }

    // R3.2 共享总帽：达限跳过该用户并计数（绝不调邮件商）
    const usage = await emailQuotaUsed(env.DB_PRIVATE);
    if (notificationQuotaExceeded(env, usage)) {
      result.quota_blocked += 1;
      continue;
    }

    const monitor = await env.DB_PRIVATE.prepare(
      `SELECT COUNT(*) AS n FROM watch_items
        WHERE user_id = ? AND status = 'active'`,
    )
      .bind(user.user_id)
      .first<{ n: number }>();

    const mail: DigestMail = {
      to: user.email_normalized,
      ...buildDigestMailContent({
        digestDate,
        events: events.map((e) => {
          const evidence = JSON.parse(e.evidence_json ?? "{}") as Record<
            string,
            unknown
          >;
          const objectName =
            typeof evidence.display_name === "string" &&
            evidence.display_name.length > 0
              ? evidence.display_name
              : "监控对象";
          const explanation =
            typeof evidence.explanation === "string"
              ? evidence.explanation
              : "";
          return { eventType: e.event_type, objectName, explanation };
        }),
        unreadCount: events.filter((e) => e.status === "unread").length,
        monitorCount: monitor?.n ?? 0,
        webBase,
      }),
    };

    const send =
      opts.sendMail ??
      (async (m: DigestMail) => {
        await createEmailProvider(env).sendDigest(m);
      });
    let sent = false;
    // R3.3 失败重试有限：立即重试 1 次（共 2 次尝试）后收口
    for (let i = 0; i < 2; i += 1) {
      try {
        await send(mail);
        sent = true;
        break;
      } catch {
        // 保留给下一次尝试；错误消息不入库（隐私最小化）
      }
    }

    if (sent) {
      await env.DB_PRIVATE.prepare(
        `INSERT INTO email_send_ledger
           (ledger_id, template, recipient_count, provider, status, request_id)
         VALUES (?, 'daily_digest', 1, ?, 'sent', ?)`,
      )
        .bind(crypto.randomUUID(), providerName, key)
        .run();
      result.sent += 1;
      result.events_aggregated += events.length;
    } else {
      await env.DB_PRIVATE.prepare(
        `INSERT INTO email_send_ledger
           (ledger_id, template, recipient_count, provider, status, request_id)
         VALUES (?, 'daily_digest', 1, ?, 'failed', ?)`,
      )
        .bind(crypto.randomUUID(), providerName, key)
        .run();
      result.failed += 1;
    }
  }
  return result;
}
