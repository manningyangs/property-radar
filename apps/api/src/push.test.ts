// TASK-05C 浏览器推送验收（PRD 任务行 1336–1342 / spec §6 测试计划）——
// VAPID ES256 JWT 结构与公钥验签；RFC 8291/8188 aes128gcm 密文头布局 + 逆推解密回环；
// dispatch 分支（开关/缺行/无订阅/幂等/404 删订阅/429 重试/渠道独立/VAPID 缺失降级）；
// cron 60 天休眠清理；GET /public/push-config。测试数据全部虚构（example.test），
// 订阅 endpoint/密钥只存在于内存库与出站桩，出站断言只看错误码不回显 endpoint。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDecipheriv,
  createHmac,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
} from "node:crypto";
import { createApp } from "./app";
import {
  createEvent,
  dispatchNotification,
  type DispatchableEvent,
} from "./events";
import {
  cleanupStalePushSubscriptions,
  encryptWebPush,
  signVapidJwt,
} from "./push";
import { createTestEnv, seedUser, type TestContext } from "./test-utils/setup";

const USER = "usr_05c_push";
const EMAIL = "push-05c@example.test";
const ENDPOINT = "https://push-provider.test/push_05c_secret_token";
const VAPID_SUBJECT = "mailto:radar-push@example.test";
const SOURCE_ID = "src_05c_push";
const WEB_BASE = "https://radar.example.test";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;
let pushStatus = 201;
let pushCalls: Array<{ headers: Record<string, string>; body: Uint8Array }>;

// ---- 测试内存密钥对（VAPID 与浏览器订阅端；仅测试内使用，不落任何持久化） ----
const vapidKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const uaKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const uaPubRaw = Uint8Array.from(
  uaKeys.publicKey.export({ type: "spki", format: "der" }).subarray(-65),
); // 未压缩点 0x04||X||Y（65 字节）
const authSecret = new Uint8Array(16).map((_, i) => (i * 7 + 3) & 0xff);
const P256DH = Buffer.from(uaPubRaw).toString("base64url");
const AUTH = Buffer.from(authSecret).toString("base64url");

function fromB64url(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64url"));
}

/** 捕获推送到桩端点的请求（出现意外 URL 即报错——测试不出网） */
function stubPush(): void {
  pushCalls = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://push-provider.test/")) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const body =
        init?.body instanceof Uint8Array
          ? Uint8Array.from(init.body)
          : new Uint8Array(0);
      pushCalls.push({ headers, body });
      return new Response(null, { status: pushStatus });
    }
    throw new Error(`测试出现意外外部请求：${url}`);
  });
  vi.stubGlobal("fetch", mock);
}

/**
 * 逆推 RFC 8291/8188 解密（用测试端 UA 私钥）：
 * 解析头 → ECDH(keyid) → HKDF(auth) → PRK(salt) → CEK/NONCE → AES-GCM → 剥 0x02 分隔符。
 * 解得回原文即证明发送端加密实现与规范一致。
 */
function decryptPushBody(body: Uint8Array): Uint8Array {
  expect(body.length).toBeGreaterThan(86);
  const salt = body.subarray(0, 16);
  const rs = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getUint32(16);
  expect(rs).toBe(4096); // RFC 8188 记录大小
  const idlen = body[20]!;
  expect(idlen).toBe(65); // RFC 8291 §4：keyid = 应用服务器临时公钥（未压缩点）
  const keyid = body.subarray(21, 21 + idlen);
  expect(keyid[0]).toBe(0x04);
  const ct = body.subarray(21 + idlen);

  const spkiPrefix = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex",
  );
  const asPub = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(keyid)]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({
    privateKey: uaKeys.privateKey,
    publicKey: asPub,
  });
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info", "utf8"),
    Buffer.from([0]),
    Buffer.from(uaPubRaw),
    Buffer.from(keyid),
  ]);
  const ikm = Buffer.from(
    hkdfSync("sha256", shared, Buffer.from(authSecret), keyInfo, 32),
  );
  const prk = createHmac("sha256", Buffer.from(salt)).update(ikm).digest();
  const cek = createHmac("sha256", prk)
    .update(
      Buffer.concat([
        Buffer.from("Content-Encoding: aes128gcm", "utf8"),
        Buffer.from([0, 1]),
      ]),
    )
    .digest()
    .subarray(0, 16);
  const nonce = createHmac("sha256", prk)
    .update(
      Buffer.concat([
        Buffer.from("Content-Encoding: nonce", "utf8"),
        Buffer.from([0, 1]),
      ]),
    )
    .digest()
    .subarray(0, 12);
  const tag = ct.subarray(ct.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(ct.subarray(0, ct.length - 16)),
    decipher.final(),
  ]);
  // 末记录分隔符必须是 0x02（RFC 8188 §2.1），剥掉后交还明文
  expect(plain[plain.length - 1]).toBe(0x02);
  return Uint8Array.from(plain.subarray(0, plain.length - 1));
}

beforeEach(async () => {
  ctx = createTestEnv();
  app = createApp();
  ctx.env.VAPID_PRIVATE_KEY = vapidKeys.privateKey
    .export({ type: "pkcs8", format: "der" })
    .toString("base64url");
  ctx.env.VAPID_PUBLIC_KEY = Buffer.from(
    vapidKeys.publicKey.export({ type: "spki", format: "der" }).subarray(-65),
  ).toString("base64url");
  ctx.env.VAPID_SUBJECT = VAPID_SUBJECT;
  ctx.env.WEB_BASE_URL = WEB_BASE;
  pushStatus = 201;
  await seedUser(ctx.priv, USER, EMAIL, "tok-05c-push");
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, '测试来源（虚构）', 'open_data')",
    )
    .run(SOURCE_ID);
  ctx.priv
    .prepare(
      "INSERT INTO notification_preferences (user_id, email_enabled, browser_push_enabled) VALUES (?, 1, 1)",
    )
    .run(USER);
  ctx.priv
    .prepare(
      `INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth)
       VALUES ('psub_05c_1', ?, ?, ?, ?)`,
    )
    .run(USER, ENDPOINT, P256DH, AUTH);
  stubPush();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function deliveries(channel: string): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare(
      "SELECT * FROM notification_deliveries WHERE channel = ? ORDER BY rowid",
    )
    .all(channel) as unknown as Array<Record<string, unknown>>;
}

function pushSubscriptions(): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM push_subscriptions ORDER BY rowid")
    .all() as unknown as Array<Record<string, unknown>>;
}

function events(): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM alert_events ORDER BY rowid")
    .all() as unknown as Array<Record<string, unknown>>;
}

/** 目标价事件（九要素种子，与 05B 同构、数据虚构） */
async function makeTargetEvent(): Promise<{ eventId: string }> {
  const res = await createEvent(ctx.env, {
    userId: USER,
    eventType: "target_price_reached",
    eventKey: "05c|push|cmt_push|snap1",
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

describe("VAPID ES256 JWT 与 RFC 8291 加密（拍板 1 完整实现）", () => {
  it("JWT：header alg=ES256，payload aud=端点 origin/exp=12h/sub=配置，公钥验签通过", async () => {
    const jwt = await signVapidJwt(ctx.env, ENDPOINT);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    const header = JSON.parse(
      new TextDecoder().decode(fromB64url(parts[0]!)),
    ) as Record<string, unknown>;
    const payload = JSON.parse(
      new TextDecoder().decode(fromB64url(parts[1]!)),
    ) as Record<string, unknown>;
    expect(header.alg).toBe("ES256");
    expect(header.typ).toBe("JWT");
    expect(payload.aud).toBe("https://push-provider.test");
    expect(payload.sub).toBe(VAPID_SUBJECT);
    const now = Math.floor(Date.now() / 1000);
    expect(Number(payload.exp)).toBeGreaterThanOrEqual(now + 11 * 3600);
    expect(Number(payload.exp)).toBeLessThanOrEqual(now + 13 * 3600);

    const spki = vapidKeys.publicKey.export({ type: "spki", format: "der" });
    const key = await crypto.subtle.importKey(
      "spki",
      Uint8Array.from(spki).buffer as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromB64url(parts[2]!) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    expect(ok).toBe(true);
  });

  it("加密：头布局 salt(16)|rs=4096|idlen=65|keyid，密文不含明文，逆推解密回环一致", async () => {
    const message = utf8Json({
      title: "房价雷达·目标价首次达成：望京西园（虚构）",
      body: "「望京西园（虚构）」挂牌中位单价已达到目标价。",
      url: `${WEB_BASE}/events`,
    });
    const body = await encryptWebPush(message, P256DH, AUTH);
    // 明文绝不出现在密文中
    const bodyStr = Buffer.from(body).toString("latin1");
    expect(bodyStr).not.toContain("望京西园");
    expect(bodyStr).not.toContain(WEB_BASE);
    const decrypted = decryptPushBody(body);
    expect(Buffer.from(decrypted).toString("utf8")).toBe(
      Buffer.from(message).toString("utf8"),
    );
  });
});

function utf8Json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

describe("dispatch 推送分支（拍板 4：与站内一致，渠道独立）", () => {
  it("开关开 + 有效订阅：1 次 POST（vapid 头/密文/投递行 sent），last_seen 刷新", async () => {
    ctx.priv
      .prepare(
        "UPDATE push_subscriptions SET last_seen_at = '2020-01-01 00:00:00' WHERE subscription_id = 'psub_05c_1'",
      )
      .run();
    await makeTargetEvent();

    expect(pushCalls).toHaveLength(1);
    const call = pushCalls[0]!;
    expect(call.headers["Authorization"]).toMatch(
      /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/,
    );
    expect(call.headers["Authorization"]).toContain(
      `k=${ctx.env.VAPID_PUBLIC_KEY}`,
    );
    expect(call.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(call.headers["Content-Type"]).toBe("application/octet-stream");
    expect(call.headers["TTL"]).toBe("86400");

    // 密文回环解密 → 载荷为中文展示文案、含事件链接，零内部字段名/邮箱/source_id
    const payload = JSON.parse(
      new TextDecoder().decode(decryptPushBody(call.body)),
    ) as Record<string, string>;
    expect(payload.title).toContain("望京西园（虚构）");
    expect(payload.body).toBe("「望京西园（虚构）」挂牌中位单价已达到目标价。");
    expect(payload.url).toBe(`${WEB_BASE}/events`);
    const raw = JSON.stringify(payload);
    for (const forbidden of [
      "metric_code",
      "difference_pct",
      "target_value",
      "stat_date",
      "evidence_json",
      "alert_events",
      SOURCE_ID,
      EMAIL,
    ]) {
      expect(raw).not.toContain(forbidden);
    }

    const push = deliveries("browser_push");
    expect(push).toHaveLength(1);
    expect(push[0]!.status).toBe("sent");
    expect(push[0]!.provider).toBe("web_push");
    expect(push[0]!.attempt_count).toBe(1);
    expect(push[0]!.last_error_code).toBeNull();
    // 出站断言不回显订阅字段
    expect(JSON.stringify(push)).not.toContain(ENDPOINT);

    const sub = pushSubscriptions()[0]!;
    expect(String(sub.last_seen_at)).not.toBe("2020-01-01 00:00:00");
    expect(sub.status).toBe("active");
    // 站内与邮件同时完成（邮件网关未配置 → email 走 provider_error，不影响本渠道）
    expect(events()).toHaveLength(1);
    expect(deliveries("in_app")).toHaveLength(1);
  });

  it("偏好缺行（browser_push_enabled 默认 0）：零推送调用、零 browser_push 行", async () => {
    ctx.priv
      .prepare("DELETE FROM notification_preferences WHERE user_id = ?")
      .run(USER);
    await makeTargetEvent();
    expect(pushCalls).toHaveLength(0);
    expect(deliveries("browser_push")).toHaveLength(0);
    expect(deliveries("in_app")).toHaveLength(1); // 站内必达红线
  });

  it("browser_push_enabled=0：零推送调用、零 browser_push 行", async () => {
    ctx.priv
      .prepare(
        "UPDATE notification_preferences SET browser_push_enabled = 0 WHERE user_id = ?",
      )
      .run(USER);
    await makeTargetEvent();
    expect(pushCalls).toHaveLength(0);
    expect(deliveries("browser_push")).toHaveLength(0);
  });

  it("开关开但无有效订阅：零推送调用、不落行", async () => {
    ctx.priv.prepare("DELETE FROM push_subscriptions").run();
    await makeTargetEvent();
    expect(pushCalls).toHaveLength(0);
    expect(deliveries("browser_push")).toHaveLength(0);
    expect(deliveries("in_app")).toHaveLength(1);
  });

  it("404：立即删订阅 + provider_error/subscription_expired，1 次尝试不重试，站内保留", async () => {
    pushStatus = 404;
    const { eventId } = await makeTargetEvent();
    expect(pushCalls).toHaveLength(1); // 404 不重试
    expect(pushSubscriptions()).toHaveLength(0); // 拍板 3：失效即删
    const push = deliveries("browser_push");
    expect(push).toHaveLength(1);
    expect(push[0]!.status).toBe("provider_error");
    expect(push[0]!.last_error_code).toBe("subscription_expired");
    expect(push[0]!.attempt_count).toBe(1);
    expect(JSON.stringify(push)).not.toContain(ENDPOINT); // 只落错误码不落 endpoint
    expect(events()[0]!.event_id).toBe(eventId);
    expect(events()[0]!.status).toBe("unread");
    expect(deliveries("in_app")[0]!.status).toBe("sent");
  });

  it("429：立即重试 1 次（共 2 次尝试）后 provider_unavailable", async () => {
    pushStatus = 429;
    await makeTargetEvent();
    expect(pushCalls).toHaveLength(2);
    const push = deliveries("browser_push");
    expect(push).toHaveLength(1);
    expect(push[0]!.status).toBe("provider_error");
    expect(push[0]!.last_error_code).toBe("provider_unavailable");
    expect(push[0]!.attempt_count).toBe(2);
  });

  it("幂等：同事件重复投递不重复推送，browser_push 行仅 1 条", async () => {
    const { eventId } = await makeTargetEvent();
    expect(pushCalls).toHaveLength(1);
    const ev: DispatchableEvent = {
      eventId,
      userId: USER,
      ruleId: null,
      eventType: "target_price_reached",
    };
    await dispatchNotification(ctx.env, ev);
    await dispatchNotification(ctx.env, ev);
    expect(pushCalls).toHaveLength(1);
    expect(deliveries("browser_push")).toHaveLength(1);
  });

  it("渠道独立（05C 拍板）：邮件达共享总帽时邮件 quota_deferred，推送照常 sent、不占账本", async () => {
    ctx.env.EMAIL_DAILY_HARD_CAP = "2";
    ctx.env.OTP_DAILY_RESERVED_CAP = "1";
    ctx.priv
      .prepare(
        `INSERT INTO email_send_ledger
           (ledger_id, template, recipient_count, provider, status)
         VALUES ('ledger_05c', 'price_alert', 1, 'google_apps_script_mail', 'sent')`,
      )
      .run();
    await makeTargetEvent();

    const email = deliveries("email");
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe("quota_deferred"); // 邮件渠道短路（05B 行为不变）

    expect(pushCalls).toHaveLength(1); // 推送不受邮件帽影响
    const push = deliveries("browser_push");
    expect(push).toHaveLength(1);
    expect(push[0]!.status).toBe("sent");
    // 账本只有预置 sent + quota_blocked 两行——推送不记账本、不占额度
    const ledger = ctx.priv
      .prepare("SELECT * FROM email_send_ledger ORDER BY rowid")
      .all() as unknown as Array<Record<string, unknown>>;
    expect(ledger).toHaveLength(2);
  });

  it("VAPID 未配置（provider_unavailable 降级）：不调端点，投递行落分类码", async () => {
    delete ctx.env.VAPID_PRIVATE_KEY;
    delete ctx.env.VAPID_PUBLIC_KEY;
    await makeTargetEvent();
    expect(pushCalls).toHaveLength(0);
    const push = deliveries("browser_push");
    expect(push).toHaveLength(1);
    expect(push[0]!.status).toBe("provider_error");
    expect(push[0]!.last_error_code).toBe("provider_unavailable");
    expect(deliveries("in_app")[0]!.status).toBe("sent");
  });
});

describe("cron 休眠订阅清理（拍板 3 后半）", () => {
  it("删除 60 天前 last_seen 的 active 订阅，新鲜订阅保留", async () => {
    ctx.priv
      .prepare(
        `INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth, last_seen_at)
         VALUES ('psub_stale', ?, 'https://push-provider.test/stale_token', ?, ?, datetime('now', '-61 days'))`,
      )
      .run(USER, P256DH, AUTH);
    const removed = await cleanupStalePushSubscriptions(ctx.env);
    expect(removed).toBe(1);
    const left = pushSubscriptions().map((r) => r.subscription_id);
    expect(left).toContain("psub_05c_1"); // 新鲜订阅保留
    expect(left).not.toContain("psub_stale");
  });
});

describe("GET /public/push-config", () => {
  it("配置了 VAPID 公钥：enabled=true 且原样返回公钥（非机密）", async () => {
    const res = await app.request("/api/v1/public/push-config", {}, ctx.env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      enabled: boolean;
      public_key?: string;
    };
    expect(data.enabled).toBe(true);
    expect(data.public_key).toBe(ctx.env.VAPID_PUBLIC_KEY);
  });

  it("未配置：enabled=false，不回错误也不回空串公钥", async () => {
    delete ctx.env.VAPID_PUBLIC_KEY;
    const res = await app.request("/api/v1/public/push-config", {}, ctx.env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      enabled: boolean;
      public_key?: string;
    };
    expect(data.enabled).toBe(false);
    expect(data.public_key).toBeUndefined();
  });
});
