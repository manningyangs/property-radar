// TASK-05B R2：每日摘要验收（spec R2.1–R2.4/R3.2/R3.3）——
// 聚合上一北京日事件、无事件不发、同日复跑零新增（幂等键）、共享总帽达限跳过计数、
// 失败重试 2 次收口、digest 偏好缺省关不进候选。发送经 sendMail 桩注入，不触外部网关。
// 测试数据全部虚构（example.test / 虚构小区），摘要日期固定以避免时区漂移。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendDailyDigest } from "./digest";
import type { DigestMail } from "./email/provider";
import { createTestEnv, seedUser, type TestContext } from "./test-utils/setup";

const USER = "usr_05b_digest";
const EMAIL = "digest-05b@example.test";
const WEB_BASE = "https://radar.example.test";
/** 北京 2026-11-13 08:00（cron 触发时刻）→ 摘要覆盖 2026-11-12 */
const NOW = new Date("2026-11-13T00:00:00Z");
const SEND_DATE = "2026-11-13";
const DIGEST_DATE = "2026-11-12";

let ctx: TestContext;
let sentMails: DigestMail[];

beforeEach(async () => {
  ctx = createTestEnv();
  ctx.env.WEB_BASE_URL = WEB_BASE;
  sentMails = [];
  await seedUser(ctx.priv, USER, EMAIL, "tok-05b-digest");
  ctx.priv
    .prepare(
      "INSERT INTO notification_preferences (user_id, email_enabled, digest_enabled) VALUES (?, 1, 1)",
    )
    .run(USER);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 捕获发送桩（R4.1 注入点） */
async function stubSender(mail: DigestMail): Promise<void> {
  sentMails.push(mail);
}

function ledgerRows(): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM email_send_ledger ORDER BY rowid")
    .all() as unknown as Array<Record<string, unknown>>;
}

/** 事件行（created_at 显式指定；+8 小时 = 北京日期） */
function insertEvent(
  eventId: string,
  eventType: string,
  createdAt: string,
  opts: { display: string; explanation: string; status?: string } = {
    display: "望京西园（虚构）",
    explanation: "「望京西园（虚构）」达到目标价。",
  },
): void {
  ctx.priv
    .prepare(
      `INSERT INTO alert_events
         (event_id, user_id, event_type, evidence_json, event_key, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      USER,
      eventType,
      JSON.stringify({
        display_name: opts.display,
        explanation: opts.explanation,
        stat_date: "2026-11-12",
      }),
      `k_${eventId}`,
      createdAt,
      opts.status ?? "unread",
    );
}

function seedYesterdayEvents(): void {
  // 北京 2026-11-12（UTC 11-11 16:00 ~ 11-12 16:00）
  insertEvent("ev_t1", "target_price_reached", "2026-11-12 03:00:00", {
    display: "望京西园（虚构）",
    explanation: "「望京西园（虚构）」挂牌中位单价已达到目标价 30000 元/㎡。",
  });
  insertEvent("ev_d1", "price_drop", "2026-11-12 05:00:00", {
    display: "回龙观小区（虚构）",
    explanation:
      "「回龙观小区（虚构）」30 天内由 42000 降至 39000 元/㎡（跌幅 7.14%）。",
    status: "read",
  });
  insertEvent("ev_a1", "data_anomaly", "2026-11-12 07:00:00", {
    display: "朝阳区（虚构）",
    explanation:
      "数据源「测试来源（虚构）」近 24 小时采集失败，「朝阳区（虚构）」的数据可能异常。",
  });
  // 今日（北京 11-13）事件不属于摘要范围
  insertEvent("ev_t2", "target_price_reached", "2026-11-13 01:00:00", {
    display: "今日小区（虚构）",
    explanation: "今日事件不应出现在昨日摘要。",
  });
  // 活跃监控 2 个 + 暂停 1 个
  ctx.priv
    .prepare(
      `INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot, status)
       VALUES ('w1', ?, 'community', 'c1', '望京西园（虚构）', 'active'),
              ('w2', ?, 'community', 'c2', '回龙观小区（虚构）', 'active'),
              ('w3', ?, 'community', 'c3', '暂停小区（虚构）', 'paused')`,
    )
    .run(USER, USER, USER);
}

describe("每日摘要聚合与正文（R2.1/R2.3）", () => {
  it("聚合上一北京日事件：概述/明细/链接齐全、今日事件不混入、账本记 sent 幂等键", async () => {
    seedYesterdayEvents();
    const result = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });

    expect(result).toMatchObject({
      candidates: 1,
      sent: 1,
      events_aggregated: 3,
      skipped_no_events: 0,
      already_sent: 0,
      quota_blocked: 0,
      failed: 0,
    });

    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0]!;
    expect(mail.to).toBe(EMAIL);
    expect(mail.date).toBe(DIGEST_DATE);
    expect(mail.subject).toBe(
      "房价雷达每日摘要 · 2026-11-12（昨日 3 条新事件）",
    );

    // 概述四行：价格变化 / 事件与未读与最高级别 / 监控数 / 数据状态
    const summary = mail.summary_lines.join("\n");
    expect(summary).toContain("目标价首次达成 1 条");
    expect(summary).toContain("窗口期降价 1 条");
    expect(summary).toContain("昨日事件共 3 条（未读 2 条）");
    expect(summary).toContain("最高级别：高");
    expect(summary).toContain("在监控 2 个对象");
    expect(summary).toContain("1 条数据异常");
    expect(summary).toContain("0 条更新延迟");

    // 明细三行（今日事件不混入）：对象、类型中文名、变化摘要、链接
    expect(mail.event_rows).toHaveLength(3);
    expect(mail.event_rows.map((r) => r.object_name)).toEqual([
      "望京西园（虚构）",
      "回龙观小区（虚构）",
      "朝阳区（虚构）",
    ]);
    expect(mail.event_rows[0]!.type_label).toBe("目标价首次达成");
    expect(mail.event_rows[1]!.type_label).toBe("窗口期降价");
    expect(mail.event_rows[2]!.type_label).toBe("数据异常");
    expect(mail.event_rows[0]!.change_summary).toContain("已达到目标价");
    expect(mail.link).toBe(`${WEB_BASE}/events`);
    expect(mail.event_rows[0]!.link).toBe(`${WEB_BASE}/events`);

    // 脱敏：正文不含内部字段名/表名/列名
    const body = JSON.stringify(mail);
    for (const forbidden of [
      "metric_code",
      "difference_pct",
      "evidence_json",
      "event_key",
      "created_at",
      "alert_events",
      "watch_items",
      "notification_preferences",
      "target_price_reached",
      "usr_05b_digest",
    ]) {
      expect(body).not.toContain(forbidden);
    }

    // 账本：sent + 幂等键 digest:{user}:{发件北京日}
    const ledger = ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.template).toBe("daily_digest");
    expect(ledger[0]!.status).toBe("sent");
    expect(ledger[0]!.request_id).toBe(`digest:${USER}:${SEND_DATE}`);
  });

  it("无上一北京日事件：跳过不发、不记账", async () => {
    insertEvent("ev_today", "target_price_reached", "2026-11-13 01:00:00");
    const result = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });
    expect(result).toMatchObject({
      candidates: 1,
      sent: 0,
      skipped_no_events: 1,
      failed: 0,
    });
    expect(sentMails).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(0);
  });

  it("digest 偏好缺省关（无偏好行）→ 不进候选、不发送", async () => {
    await seedUser(ctx.priv, "usr_05b_off", "off-05b@example.test", "tok-off");
    const result = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });
    expect(result.candidates).toBe(1); // 仅开偏好用户
    expect(sentMails).toHaveLength(0);
  });

  it("TASK-06B 拍板2：冻结用户不进摘要候选（解冻恢复）", async () => {
    seedYesterdayEvents(); // 有事件，确保候选差异只来自 status
    const active = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });
    expect(active.candidates).toBe(1);

    ctx.priv
      .prepare("UPDATE users SET status = 'frozen' WHERE user_id = ?")
      .run(USER);
    const frozen = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });
    expect(frozen.candidates).toBe(0);
    expect(frozen.sent).toBe(0);
  });
});

describe("每日摘要幂等、限额与重试（R2.2/R3.2/R3.3）", () => {
  it("同日复跑：第二轮 already_sent，零新增发送与账本", async () => {
    seedYesterdayEvents();
    const first = await sendDailyDigest(ctx.env, NOW, { sendMail: stubSender });
    expect(first.sent).toBe(1);
    const second = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });
    expect(second).toMatchObject({
      already_sent: 1,
      sent: 0,
      skipped_no_events: 0,
    });
    expect(sentMails).toHaveLength(1);
    expect(ledgerRows()).toHaveLength(1);
  });

  it("共享总帽达限：跳过该用户并计 quota_blocked，不调邮件商、不新增账本", async () => {
    seedYesterdayEvents();
    // 通知侧上限 = 3 − 1 = 2；预置 2 条已发送（通知模板）
    ctx.env.EMAIL_DAILY_HARD_CAP = "3";
    ctx.env.OTP_DAILY_RESERVED_CAP = "1";
    for (let i = 0; i < 2; i += 1) {
      ctx.priv
        .prepare(
          `INSERT INTO email_send_ledger
             (ledger_id, template, recipient_count, provider, status)
           VALUES (?, 'price_alert', 1, 'google_apps_script_mail', 'sent')`,
        )
        .run(`ledger_preset_${i}`);
    }
    const result = await sendDailyDigest(ctx.env, NOW, {
      sendMail: stubSender,
    });
    expect(result.quota_blocked).toBe(1);
    expect(result.sent).toBe(0);
    expect(sentMails).toHaveLength(0);
    expect(ledgerRows()).toHaveLength(2); // 预置 2 条，零新增
  });

  it("发送失败：立即重试 1 次（共 2 次尝试）后 failed 计数，账本记 failed", async () => {
    seedYesterdayEvents();
    const attempts: string[] = [];
    const result = await sendDailyDigest(ctx.env, NOW, {
      sendMail: async (mail) => {
        attempts.push(mail.to);
        throw new Error("provider boom");
      },
    });
    expect(attempts).toHaveLength(2);
    expect(result).toMatchObject({ failed: 1, sent: 0 });
    const ledger = ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.status).toBe("failed");
    expect(ledger[0]!.template).toBe("daily_digest");
    // 错误消息与邮箱不入库
    expect(JSON.stringify(ledger)).not.toContain("provider boom");
    expect(JSON.stringify(ledger)).not.toContain(EMAIL);
  });
});
