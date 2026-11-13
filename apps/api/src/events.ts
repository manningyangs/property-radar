// TASK-05A/05B：事件核心（PRD §2.8 事件中心 / §9.2 alert_events·notification_deliveries / §11）
// 红线（US-08/§8.8）：事件先落 alert_events，投递后置且 try/catch 隔离——
// 邮件 provider 不可用/抛错绝不回滚、绝不删除站内事件。
// 05B：dispatchNotification 接真实发送（R1.1/R3.2/R3.3）——共享总帽核验 → 九要素正文 →
// sendEvent 立即重试 1 次（共 2 次尝试）→ email 行 sent/provider_error/quota_deferred +
// 账本 sent/quota_blocked；不配置网关时如实落 provider_unavailable（不谎称已发送 §11）。
import type { Env } from "./env";
import { buildEventMailContent } from "./email/content";
import { createEmailProvider, EmailProviderError } from "./email/provider";
import { emailQuotaUsed, notificationQuotaExceeded } from "./email/quota";

export const EVENT_TYPES = [
  "target_price_reached",
  "price_drop",
  "data_anomaly",
  "update_delayed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** 亚洲/上海当日（YYYY-MM-DD）——事件幂等键与延迟判定的日期口径 */
export function shanghaiDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** 日期字符串加减天数（日历日，UTC 解析避免时区漂移） */
export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 两个 YYYY-MM-DD 之间的日历天数（to - from） */
export function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export interface CreateEventInput {
  userId: string;
  ruleId?: string | null;
  watchId?: string | null;
  snapshotId?: string | null;
  eventType: EventType;
  oldValue?: number | null;
  newValue?: number | null;
  targetValue?: number | null;
  differencePct?: number | null;
  evidence: Record<string, unknown>;
  /** 幂等去重键（UNIQUE）：规则类 rule|object|metric|snapshot；系统类 watch×日/任务 */
  eventKey: string;
}

export interface CreateEventResult {
  created: boolean;
  eventId: string;
}

export interface DispatchableEvent {
  eventId: string;
  userId: string;
  ruleId: string | null;
  eventType: EventType;
}

export interface DispatchOptions {
  /**
   * 邮件发送接缝（05B）：缺省走真实 provider（sendEventByEmail，九要素正文 + HMAC 网关）；
   * 测试可注入成功桩/抛错桩替换“发送”这一步——额度核验、落行与重试计数仍由 dispatchNotification 负责。
   */
  sendEmail?: (event: DispatchableEvent) => Promise<void>;
}

/** 账本记账（R3.2：仅 sent/quota_blocked；不存收件人，request_id 用事件 ID 可追溯） */
async function recordLedger(
  env: Env,
  template: "price_alert" | "daily_digest",
  status: "sent" | "quota_blocked",
  requestId: string,
): Promise<void> {
  const providerName = (env.EMAIL_PROVIDER ?? "google_apps_script_mail").trim();
  await env.DB_PRIVATE.prepare(
    `INSERT INTO email_send_ledger
       (ledger_id, template, recipient_count, provider, status, request_id)
     VALUES (?, ?, 1, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), template, providerName, status, requestId)
    .run();
}

/** 投递错误码分类（R3.3）：网关未配置=provider_unavailable（沿用 05A 语义），其余保留分类码；未知错误=provider_error */
function deliveryErrorCode(err: unknown): string {
  if (err instanceof EmailProviderError) {
    const reason = err.message.split(":").pop() ?? "";
    if (reason === "gateway_not_configured") return "provider_unavailable";
    if (reason.length > 0) return reason;
  }
  return "provider_error";
}

/** 来源展示名：evidence 来源名 → 来源目录名 → “未知”（绝不把 source_id 写进正文） */
async function resolveSourceName(
  env: Env,
  evidence: Record<string, unknown>,
): Promise<string> {
  const direct = evidence.source_name;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const sourceId =
    typeof evidence.source_id === "string"
      ? evidence.source_id
      : typeof evidence.latest_source_id === "string"
        ? evidence.latest_source_id
        : null;
  if (!sourceId) return "未知";
  const row = await env.DB_PUBLIC.prepare(
    "SELECT name FROM data_sources_public WHERE source_id = ?",
  )
    .bind(sourceId)
    .first<{ name: string }>();
  return row?.name ?? "未知";
}

/**
 * 缺省真实发送（R1.1/R1.2）：查事件行与收件邮箱 → 构造九要素正文 → provider.sendEvent。
 * 重试统一由 dispatchNotification 负责，本函数单次尝试；正文与日志不落邮箱明文（R3.4）。
 */
async function sendEventByEmail(
  env: Env,
  event: DispatchableEvent,
): Promise<void> {
  const row = await env.DB_PRIVATE.prepare(
    `SELECT event_type, old_value, new_value, target_value, difference_pct, evidence_json
       FROM alert_events WHERE event_id = ?`,
  )
    .bind(event.eventId)
    .first<{
      event_type: string;
      old_value: number | null;
      new_value: number | null;
      target_value: number | null;
      difference_pct: number | null;
      evidence_json: string | null;
    }>();
  if (!row) throw new EmailProviderError("event_missing");
  const user = await env.DB_PRIVATE.prepare(
    "SELECT email_normalized FROM users WHERE user_id = ?",
  )
    .bind(event.userId)
    .first<{ email_normalized: string }>();
  if (!user) throw new EmailProviderError("recipient_unavailable");

  const evidence = JSON.parse(row.evidence_json ?? "{}") as Record<
    string,
    unknown
  >;
  const content = buildEventMailContent({
    eventType: row.event_type,
    values: {
      oldValue: row.old_value,
      newValue: row.new_value,
      targetValue: row.target_value,
      differencePct: row.difference_pct,
    },
    evidence,
    sourceName: await resolveSourceName(env, evidence),
    webBase: (env.WEB_BASE_URL ?? "http://localhost:4321").trim(),
  });
  const provider = createEmailProvider(env);
  await provider.sendEvent({ to: user.email_normalized, ...content });
}

/** 投递：in_app 必达（站内事件即投递本体）；email 按偏好核验 → 共享总帽 → 发送（失败立即重试 1 次） */
export async function dispatchNotification(
  env: Env,
  event: DispatchableEvent,
  opts: DispatchOptions = {},
): Promise<void> {
  // 1) 站内投递（与事件同库、状态 sent）
  await env.DB_PRIVATE.prepare(
    `INSERT INTO notification_deliveries
       (delivery_id, event_id, user_id, channel, provider, status, attempt_count, sent_at)
     VALUES (?, ?, ?, 'in_app', 'in_app', 'sent', 0, datetime('now'))`,
  )
    .bind(newId("dlv"), event.eventId, event.userId)
    .run();

  // 2) 邮件偏好（缺行 = 默认开，0001 DEFAULT 1；规则侧缺行 = 默认开）
  const pref = await env.DB_PRIVATE.prepare(
    "SELECT email_enabled FROM notification_preferences WHERE user_id = ?",
  )
    .bind(event.userId)
    .first<{ email_enabled: number }>();
  if (pref !== null && pref.email_enabled !== 1) return;
  if (event.ruleId !== null) {
    const setting = await env.DB_PRIVATE.prepare(
      "SELECT notify_email FROM watch_rule_settings WHERE rule_id = ?",
    )
      .bind(event.ruleId)
      .first<{ notify_email: number }>();
    if (setting !== null && setting.notify_email !== 1) return;
  }

  // 3) R1.4 发送幂等：同事件已有非 quota_deferred 邮件投递行 → 不重复发送
  const existing = await env.DB_PRIVATE.prepare(
    `SELECT delivery_id, status FROM notification_deliveries
      WHERE event_id = ? AND channel = 'email' LIMIT 1`,
  )
    .bind(event.eventId)
    .first<{ delivery_id: string; status: string }>();
  if (existing && existing.status !== "quota_deferred") return;

  // 4) R3.2 共享总帽：达限不调 provider，投递行 quota_deferred（attempt 0）+ 账本 quota_blocked
  const usage = await emailQuotaUsed(env.DB_PRIVATE);
  if (notificationQuotaExceeded(env, usage)) {
    if (existing) {
      await env.DB_PRIVATE.prepare(
        `UPDATE notification_deliveries
            SET status = 'quota_deferred', attempt_count = 0,
                last_error_code = 'quota_blocked', sent_at = NULL
          WHERE delivery_id = ?`,
      )
        .bind(existing.delivery_id)
        .run();
    } else {
      await env.DB_PRIVATE.prepare(
        `INSERT INTO notification_deliveries
           (delivery_id, event_id, user_id, channel, provider, status, attempt_count, last_error_code)
         VALUES (?, ?, ?, 'email', 'apps_script', 'quota_deferred', 0, 'quota_blocked')`,
      )
        .bind(newId("dlv"), event.eventId, event.userId)
        .run();
    }
    await recordLedger(env, "price_alert", "quota_blocked", event.eventId);
    return;
  }

  // 5) 发送：缺省真实 provider；测试经 sendEmail 接缝注入桩。失败立即重试 1 次（共 2 次尝试，R3.3）
  const send =
    opts.sendEmail ?? ((ev: DispatchableEvent) => sendEventByEmail(env, ev));
  let attempts = 0;
  let failure: unknown = null;
  for (let i = 0; i < 2; i += 1) {
    attempts = i + 1;
    try {
      await send(event);
      failure = null;
      break;
    } catch (err) {
      failure = err;
    }
  }

  const deliveryId = existing?.delivery_id ?? newId("dlv");
  if (failure === null) {
    if (existing) {
      await env.DB_PRIVATE.prepare(
        `UPDATE notification_deliveries
            SET status = 'sent', attempt_count = ?, last_error_code = NULL,
                sent_at = datetime('now')
          WHERE delivery_id = ?`,
      )
        .bind(attempts, deliveryId)
        .run();
    } else {
      await env.DB_PRIVATE.prepare(
        `INSERT INTO notification_deliveries
           (delivery_id, event_id, user_id, channel, provider, status, attempt_count, sent_at)
         VALUES (?, ?, ?, 'email', 'apps_script', 'sent', ?, datetime('now'))`,
      )
        .bind(deliveryId, event.eventId, event.userId, attempts)
        .run();
    }
    await recordLedger(env, "price_alert", "sent", event.eventId);
    return;
  }

  // 只落错误码，不落错误消息（可能含收件人/上游内容，隐私最小化 R3.4）
  const errorCode = deliveryErrorCode(failure);
  if (existing) {
    await env.DB_PRIVATE.prepare(
      `UPDATE notification_deliveries
          SET status = 'provider_error', attempt_count = ?, last_error_code = ?,
              sent_at = NULL
        WHERE delivery_id = ?`,
    )
      .bind(attempts, errorCode, deliveryId)
      .run();
  } else {
    await env.DB_PRIVATE.prepare(
      `INSERT INTO notification_deliveries
         (delivery_id, event_id, user_id, channel, provider, status, attempt_count, last_error_code)
       VALUES (?, ?, ?, 'email', 'apps_script', 'provider_error', ?, ?)`,
    )
      .bind(deliveryId, event.eventId, event.userId, attempts, errorCode)
      .run();
  }
}

/**
 * 创建事件（唯一写入 alert_events 的入口）：
 * 事件先写 → 投递后置且整体 try/catch——邮件/provider 任何故障都无法回滚站内事件（US-08）。
 * event_key UNIQUE 冲突 → created=false（批次复跑/重复评估幂等）且不重复投递。
 */
export async function createEvent(
  env: Env,
  input: CreateEventInput,
  dispatchOpts: DispatchOptions = {},
): Promise<CreateEventResult> {
  const eventId = newId("evt");
  const res = await env.DB_PRIVATE.prepare(
    `INSERT INTO alert_events
       (event_id, user_id, rule_id, watch_id, snapshot_id, event_type,
        old_value, new_value, target_value, difference_pct, evidence_json,
        event_key, status, read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', NULL)
     ON CONFLICT (event_key) DO NOTHING`,
  )
    .bind(
      eventId,
      input.userId,
      input.ruleId ?? null,
      input.watchId ?? null,
      input.snapshotId ?? null,
      input.eventType,
      input.oldValue ?? null,
      input.newValue ?? null,
      input.targetValue ?? null,
      input.differencePct ?? null,
      JSON.stringify(input.evidence ?? {}),
      input.eventKey,
    )
    .run();
  if ((res.meta.changes ?? 0) === 0) {
    return { created: false, eventId: "" }; // 幂等命中：不投递
  }
  try {
    await dispatchNotification(
      env,
      {
        eventId,
        userId: input.userId,
        ruleId: input.ruleId ?? null,
        eventType: input.eventType,
      },
      dispatchOpts,
    );
  } catch {
    // 投递失败不影响事件（日志由调用方/网关统一记录；此处静默保事件）
  }
  return { created: true, eventId };
}
