// TASK-05A：事件核心（PRD §2.8 事件中心 / §9.2 alert_events·notification_deliveries / §11）
// 红线（US-08/§8.8）：事件先落 alert_events，投递后置且 try/catch 隔离——
// 邮件 provider 不可用/抛错绝不回滚、绝不删除站内事件。
// 05A 不发送真实邮件（05B 经 dispatchNotification 的 sendEmail 接缝接入真实 provider），
// email 行如实落 provider_error + provider_unavailable（不得谎称已发送）。
import type { Env } from "./env";

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
   * 邮件真实发送接缝（05B 在此接入 provider）。
   * 05A 缺省不提供 → email 行落 provider_error/provider_unavailable；
   * 测试注入抛错桩以验证「provider 故障 → 站内事件保留」。
   */
  sendEmail?: (event: DispatchableEvent) => Promise<void>;
}

/** 投递：in_app 必达（站内事件即投递本体）；email 按通知偏好占位，失败不影响事件 */
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

  // 3) 邮件行（05A：未接 provider → 如实 provider_error；不谎称已发送 §11）
  const deliveryId = newId("dlv");
  if (!opts.sendEmail) {
    await env.DB_PRIVATE.prepare(
      `INSERT INTO notification_deliveries
         (delivery_id, event_id, user_id, channel, provider, status, attempt_count, last_error_code)
       VALUES (?, ?, ?, 'email', 'apps_script', 'provider_error', 0, 'provider_unavailable')`,
    )
      .bind(deliveryId, event.eventId, event.userId)
      .run();
    return;
  }
  try {
    await opts.sendEmail(event);
    await env.DB_PRIVATE.prepare(
      `INSERT INTO notification_deliveries
         (delivery_id, event_id, user_id, channel, provider, status, attempt_count, sent_at)
       VALUES (?, ?, ?, 'email', 'apps_script', 'sent', 1, datetime('now'))`,
    )
      .bind(deliveryId, event.eventId, event.userId)
      .run();
  } catch {
    // 只落错误码，不落错误消息（可能含收件人/上游内容，隐私最小化）
    await env.DB_PRIVATE.prepare(
      `INSERT INTO notification_deliveries
         (delivery_id, event_id, user_id, channel, provider, status, attempt_count, last_error_code)
       VALUES (?, ?, ?, 'email', 'apps_script', 'provider_error', 1, 'provider_error')`,
    )
      .bind(deliveryId, event.eventId, event.userId)
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
