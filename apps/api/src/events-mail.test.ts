// TASK-05B R1：事件邮件验收（PRD 任务行 1332 / spec R1.2/R1.4/R3.3）——
// 网关经 stubFetch 桩捕获：九要素正文齐全、零内部字段名、HMAC 签名可重算；
// 同事件重复投递不重发；网关持续失败时重试 2 次收口且站内事件保留。
// 测试数据全部虚构（example.test / 虚构小区与来源），邮箱仅存在于内存库与出站桩链路。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256Hex } from "./crypto";
import { gatewayCanonical } from "./email/apps-script";
import {
  createEvent,
  dispatchNotification,
  type DispatchableEvent,
} from "./events";
import { createTestEnv, seedUser, type TestContext } from "./test-utils/setup";

const USER = "usr_05b_mail";
const GW_URL = "https://apps-script.test/gateway";
const GW_SECRET = "test-gateway-secret-05b";
const WEB_BASE = "https://radar.example.test";
const EMAIL = "mail-05b@example.test";
const SOURCE_ID = "src_05b_mail";

let ctx: TestContext;
let gatewayOk = true;
let gatewayCalls: Array<{ init?: RequestInit }> = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 捕获邮件网关请求（Turnstile 不在本文件链路，出现即报错） */
function stubFetch(): void {
  gatewayCalls = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("apps-script.test")) {
      gatewayCalls.push({ init });
      return jsonResponse(
        gatewayOk ? { ok: true } : { ok: false, error: "quota_exhausted" },
      );
    }
    throw new Error(`测试出现意外外部请求：${url}`);
  });
  vi.stubGlobal("fetch", mock);
}

beforeEach(async () => {
  ctx = createTestEnv();
  ctx.env.APPS_SCRIPT_WEB_APP_URL = GW_URL;
  ctx.env.APPS_SCRIPT_HMAC_SECRET = GW_SECRET;
  ctx.env.WEB_BASE_URL = WEB_BASE;
  gatewayOk = true;
  await seedUser(ctx.priv, USER, EMAIL, "tok-05b-mail");
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, '测试来源（虚构）', 'open_data')",
    )
    .run(SOURCE_ID);
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function lastBody(): string {
  expect(gatewayCalls.length).toBeGreaterThan(0);
  return String(gatewayCalls[gatewayCalls.length - 1]?.init?.body);
}

function deliveries(channel: string): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare(
      "SELECT * FROM notification_deliveries WHERE channel = ? ORDER BY rowid",
    )
    .all(channel) as unknown as Array<Record<string, unknown>>;
}

function ledgerRows(): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM email_send_ledger ORDER BY rowid")
    .all() as unknown as Array<Record<string, unknown>>;
}

function events(): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM alert_events ORDER BY rowid")
    .all() as unknown as Array<Record<string, unknown>>;
}

/** 目标价事件（九要素种子：对象/指标/目标/当前/价差/日期/来源/样本量） */
async function makeTargetEvent(): Promise<{ eventId: string }> {
  const res = await createEvent(ctx.env, {
    userId: USER,
    eventType: "target_price_reached",
    eventKey: "05b|mail|cmt_mail|snap1",
    oldValue: 32000,
    newValue: 29500,
    targetValue: 30000,
    differencePct: -7.81,
    evidence: {
      display_name: "望京西园（虚构）",
      metric_label: "挂牌中位单价",
      unit: "元/㎡",
      target_value: 30000,
      target_gap_pct: -1.67,
      stat_date: "2026-11-11",
      source_id: SOURCE_ID,
      sample_count: 35,
      quality_status: "valid",
      explanation: "「望京西园（虚构）」挂牌中位单价已达到目标价。",
    },
  });
  expect(res.created).toBe(true);
  return { eventId: res.eventId };
}

describe("事件邮件正文（九要素）与脱敏", () => {
  it("网关收到 price_alert：九要素齐全、值为中文展示文案、零内部字段名", async () => {
    await makeTargetEvent();
    const body = lastBody();
    const p = JSON.parse(body) as Record<string, unknown>;

    // 模板与收件（收件邮箱仅存在于出站链路，不入库/日志）
    expect(p.template).toBe("price_alert");
    expect(p.to).toBe(EMAIL);
    // 九要素（PRD 任务行 1332）
    expect(String(p.subject)).toContain("望京西园（虚构）");
    expect(p.object_name).toBe("望京西园（虚构）");
    expect(p.metric_name).toBe("挂牌中位单价");
    expect(p.target).toBe("30000 元/㎡");
    expect(p.current).toBe("29500 元/㎡");
    expect(String(p.gap)).toContain("-500 元/㎡");
    expect(String(p.gap)).toContain("-1.67%");
    expect(p.date).toBe("2026-11-11");
    expect(p.source).toBe("测试来源（虚构）");
    expect(p.samples).toBe("35 条");
    expect(p.link).toBe(`${WEB_BASE}/events`);

    // 脱敏：正文不得出现内部字段名/表名/列名/原始来源 ID
    for (const forbidden of [
      "metric_code",
      "metric_label",
      "difference_pct",
      "target_value",
      "new_value",
      "old_value",
      "stat_date",
      "sample_count",
      "evidence_json",
      "alert_events",
      "watch_rules",
      "price_snapshots",
      SOURCE_ID,
    ]) {
      expect(body).not.toContain(forbidden);
    }

    // 账本记账 sent（模板 price_alert）+ 投递行 sent
    const ledger = ledgerRows();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.template).toBe("price_alert");
    expect(ledger[0]!.status).toBe("sent");
    const email = deliveries("email");
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe("sent");
    expect(email[0]!.attempt_count).toBe(1);
  });

  it("网关调用带 HMAC 签名/时间戳/request_id，签名可按规范串重算", async () => {
    await makeTargetEvent();
    const headers = (gatewayCalls[gatewayCalls.length - 1]?.init?.headers ??
      {}) as Record<string, string>;
    const timestamp = headers["X-PR-Timestamp"] ?? "";
    const requestId = headers["X-PR-Request-Id"] ?? "";
    const signature = headers["X-PR-Signature"] ?? "";
    expect(timestamp).toMatch(/^\d{10}$/);
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    const expected = await hmacSha256Hex(
      GW_SECRET,
      gatewayCanonical("POST", lastBody(), timestamp, requestId),
    );
    expect(signature).toBe(expected);
  });
});

describe("事件邮件幂等（R1.4）", () => {
  it("同一事件重复投递：delivery 行短路，不重复调用网关、账本仅一条 sent", async () => {
    const { eventId } = await makeTargetEvent();
    expect(gatewayCalls).toHaveLength(1);

    const ev: DispatchableEvent = {
      eventId,
      userId: USER,
      ruleId: null,
      eventType: "target_price_reached",
    };
    await dispatchNotification(ctx.env, ev);
    await dispatchNotification(ctx.env, ev);

    expect(gatewayCalls).toHaveLength(1); // 网关只被调用一次
    expect(deliveries("email")).toHaveLength(1);
    expect(ledgerRows()).toHaveLength(1);
  });
});

describe("共享总帽（R3.2/拍板 3）", () => {
  it("通知侧达限：不调网关，email 行 quota_deferred（attempt 0），账本记 quota_blocked", async () => {
    // 通知侧上限 = 总帽 2 − OTP 预留 1 = 1；预置 1 条通知已发送 → 达限
    ctx.env.EMAIL_DAILY_HARD_CAP = "2";
    ctx.env.OTP_DAILY_RESERVED_CAP = "1";
    ctx.priv
      .prepare(
        `INSERT INTO email_send_ledger
           (ledger_id, template, recipient_count, provider, status)
         VALUES ('ledger_preset', 'price_alert', 1, 'google_apps_script_mail', 'sent')`,
      )
      .run();

    const { eventId } = await makeTargetEvent();

    // 绝不调邮件商
    expect(gatewayCalls).toHaveLength(0);
    // 站内事件与 in_app 投递保留（US-08 红线）
    expect(events()).toHaveLength(1);
    expect(deliveries("in_app")[0]!.status).toBe("sent");
    // 邮件投递行如实落 quota_deferred（不谎称已发送）
    const email = deliveries("email");
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe("quota_deferred");
    expect(email[0]!.attempt_count).toBe(0);
    expect(email[0]!.last_error_code).toBe("quota_blocked");
    expect(email[0]!.event_id).toBe(eventId);
    // 账本：预置 sent + 本次 quota_blocked（quota_blocked 不占额度）
    const ledger = ledgerRows();
    expect(ledger).toHaveLength(2);
    expect(ledger[1]!.status).toBe("quota_blocked");
    expect(ledger[1]!.template).toBe("price_alert");
  });
});

describe("邮件失败回退站内（R3.3 回归）", () => {
  it("网关持续失败：恰 2 次尝试后 provider_error，站内事件与 in_app 保留，账本零 sent", async () => {
    gatewayOk = false;
    const { eventId } = await makeTargetEvent();

    // 站内事件保留（US-08 红线）
    const evRows = events();
    expect(evRows).toHaveLength(1);
    expect(evRows[0]!.event_id).toBe(eventId);
    expect(evRows[0]!.status).toBe("unread");
    const inApp = deliveries("in_app");
    expect(inApp).toHaveLength(1);
    expect(inApp[0]!.status).toBe("sent");

    // 邮件：2 次尝试（立即重试 1 次）后放弃，分类码落行
    expect(gatewayCalls).toHaveLength(2);
    const email = deliveries("email");
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe("provider_error");
    expect(email[0]!.attempt_count).toBe(2);
    expect(email[0]!.last_error_code).toBe("quota_exhausted");

    // 失败不记 sent 账；错误消息与邮箱不入库
    expect(ledgerRows()).toHaveLength(0);
    expect(JSON.stringify(email)).not.toContain(EMAIL);
  });

  it("email_enabled=0 用户：不调用网关、不写 email 投递行", async () => {
    ctx.priv
      .prepare(
        "INSERT INTO notification_preferences (user_id, email_enabled) VALUES (?, 0)",
      )
      .run(USER);
    await makeTargetEvent();
    expect(gatewayCalls).toHaveLength(0);
    expect(deliveries("email")).toHaveLength(0);
    expect(deliveries("in_app")).toHaveLength(1);
  });
});
