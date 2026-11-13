// TASK-05C：浏览器 Web Push 发送链路（PRD 任务行 1336–1342 / §7.2 / §11.2）。
// 拍板 1：完整实现——真实 VAPID（ES256 JWT，WebCrypto 零依赖）+ RFC 8291 aes128gcm 载荷加密；
// 本地 e2e 用桩端点验证请求头与密文，真实浏览器订阅偏差如实记录。
// 红线：endpoint/p256dh/auth 只入私库、不入日志（本模块不打印任何订阅字段）；
// 只落错误码不落 endpoint（隐私最小化）；不占邮件总帽。
// 字节级协议依据（已核对 rfc-editor 原文）：
//   RFC 8291 §3.3/§3.4：PRK_key=HMAC(auth,ecdh)、key_info="WebPush: info"||0x00||ua_public||as_public、
//   IKM=HMAC(PRK_key, key_info||0x01)（L=32）；单记录（§4）、keyid=65 字节未压缩点、rs>明文+1+16。
//   RFC 8188 §2.1–2.3：头 salt(16)||rs(4,大端)||idlen(1)||keyid；PRK=HMAC(salt,IKM)、
//   CEK=HMAC(PRK, cek_info||0x01)[0..15]、NONCE=HMAC(PRK, nonce_info||0x01)[0..11] XOR SEQ
//   （单记录 SEQ=0 即不异或）；末记录分隔符 0x02；AAD 零长度。
import type { Env } from "./env";
import { buildEventMailContent } from "./email/content";

/** 推送所需的最小事件引用（避免与 events.ts 循环依赖，DispatchableEvent 结构兼容） */
export interface PushEventRef {
  eventId: string;
  userId: string;
}

/**
 * 推送投递错误：code 直接落 notification_deliveries.last_error_code；
 * retryable 决定 dispatch 是否立即重试（429/5xx/网络=重试 1 次；404/410/其他 4xx 立即收口）。
 */
export class PushError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = "PushError";
    this.code = code;
    this.retryable = retryable;
  }
}

// ---------------- base64url（Workers 与 Node 22 通用，无依赖） ----------------

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url/base64 双兼容解码（订阅 keys 为无填充 base64url；宽容补 padding） */
function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------- VAPID（RFC 8296：ES256 JWT） ----------------

/**
 * VAPID 私钥导入（PKCS#8 DER 的 base64url；Secret）。
 * 生成（本地/生产同法）：node -e "const c=require('node:crypto');const{privateKey,publicKey}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});console.log('VAPID_PRIVATE_KEY='+privateKey.export({type:'pkcs8',format:'der'}).toString('base64url'));console.log('VAPID_PUBLIC_KEY='+publicKey.export({type:'spki',format:'der'}).subarray(-65).toString('base64url'));"
 */
async function importVapidPrivateKey(b64urlKey: string): Promise<CryptoKey> {
  const der = b64urlDecode(b64urlKey);
  return crypto.subtle.importKey(
    "pkcs8",
    der.buffer.slice(
      der.byteOffset,
      der.byteOffset + der.byteLength,
    ) as ArrayBuffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

/**
 * VAPID JWT（ES256）：payload { aud: endpoint origin, exp: now+12h, sub }；
 * WebCrypto ECDSA 返回 r||s 裸签名（64 字节），正是 JWS ES256 要求的格式。
 */
export async function signVapidJwt(
  env: Env,
  endpoint: string,
): Promise<string> {
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  if (!priv) throw new PushError("provider_unavailable", true);
  const sub = env.VAPID_SUBJECT?.trim() || "mailto:admin@example.com";
  const aud = new URL(endpoint).origin; // aud = 订阅端点的 origin（RFC 8296 §3.1）
  const header = { alg: "ES256", typ: "JWT" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600, // 有效期 12 小时
    sub,
  };
  const signingInput = `${b64urlEncode(utf8(JSON.stringify(header)))}.${b64urlEncode(
    utf8(JSON.stringify(payload)),
  )}`;
  const key = await importVapidPrivateKey(priv);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput),
  );
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ---------------- RFC 8291：aes128gcm 载荷加密 ----------------

/**
 * 加密单条推送载荷（RFC 8291 单记录约束）。
 * @param payload 明文（UTF-8 JSON，由调用方编码）
 * @param p256dh  订阅公钥（base64url 未压缩点 65 字节）
 * @param auth     认证密钥（base64url 16 字节）
 * @returns body = salt(16) || rs(4, 大端=4096) || idlen(1)=65 || keyid(65) || ciphertext+tag
 */
export async function encryptWebPush(
  payload: Uint8Array,
  p256dh: string,
  auth: string,
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new PushError("provider_error", false); // 非法订阅公钥（分类码，不落密钥）
  }
  if (authSecret.length !== 16) {
    throw new PushError("provider_error", false);
  }

  // 应用服务器每条消息生成新的临时 ECDH 密钥对（§3.1）
  const eph = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", eph.publicKey)) as ArrayBuffer,
  ); // 65 字节未压缩点
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic.buffer.slice(
      uaPublic.byteOffset,
      uaPublic.byteOffset + uaPublic.byteLength,
    ) as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  // ECDH 共享密钥：标准/Node 实现读 `public`；Cloudflare workers-types 声明为 `$public`
  // （生成器对保留字的转义）——两个键同时携带，运行时各取所需，多余键被忽略。
  const ecdhParams = {
    name: "ECDH",
    public: uaKey,
    $public: uaKey,
  } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(ecdhParams, eph.privateKey, 256),
  );

  // RFC 8291 §3.3：HKDF(salt=auth, ikm=ecdh, info=key_info, L=32) → IKM
  const keyInfo = concatBytes(
    utf8("WebPush: info"),
    new Uint8Array([0]),
    uaPublic,
    asPublic,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    ecdhSecret.buffer.slice(
      ecdhSecret.byteOffset,
      ecdhSecret.byteOffset + ecdhSecret.byteLength,
    ) as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo },
      hkdfKey,
      256,
    ),
  );

  // RFC 8188 §2.1：头盐（每条消息随机 16 字节）
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8188 §2.2/2.3：CEK(16) / NONCE(12)（单记录 SEQ=0，不异或）
  const hkdfKey2 = await crypto.subtle.importKey(
    "raw",
    ikm.buffer.slice(
      ikm.byteOffset,
      ikm.byteOffset + ikm.byteLength,
    ) as ArrayBuffer,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const cek = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: concatBytes(
          utf8("Content-Encoding: aes128gcm"),
          new Uint8Array([0]),
        ),
      },
      hkdfKey2,
      128,
    ),
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: concatBytes(utf8("Content-Encoding: nonce"), new Uint8Array([0])),
      },
      hkdfKey2,
      96,
    ),
  );

  // 单记录明文 = payload || 0x02（末记录分隔符；无需补零，rs 足够大）
  const plain = concatBytes(payload, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek.buffer.slice(
      cek.byteOffset,
      cek.byteOffset + cek.byteLength,
    ) as ArrayBuffer,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: new Uint8Array(0) }, // AAD 零长度
      aesKey,
      plain,
    ),
  );

  // 头：salt(16) || rs(4, 大端) || idlen(1)=65 || keyid=临时公钥(65)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 0xff;
  header[17] = (rs >>> 16) & 0xff;
  header[18] = (rs >>> 8) & 0xff;
  header[19] = rs & 0xff;
  header[20] = 65;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

// ---------------- 发送（单次尝试；重试与落行由 dispatchNotification 负责） ----------------

interface PushSubscriptionRow {
  subscription_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 构造推送载荷：复用邮件同源构建规则（中文事件名/对象/差值/链接，零内部字段名、零 source_id、不落邮箱） */
async function buildPushPayload(
  env: Env,
  event: PushEventRef,
): Promise<{ title: string; body: string; url: string; tag: string }> {
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
  if (!row) throw new PushError("provider_error", false); // 事件缺失（不重试）
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
    sourceName: "", // 推送正文不含来源行（邮件才带 source；此处不参与拼装）
    webBase: (env.WEB_BASE_URL ?? "http://localhost:4321").trim(),
  });
  const explanation =
    typeof evidence.explanation === "string" && evidence.explanation.length > 0
      ? evidence.explanation
      : `${content.metric_name}：${content.current}`;
  return {
    title: content.subject,
    body: explanation,
    url: content.link,
    tag: event.eventId,
  };
}

/**
 * 单次推送尝试（与 05B sendEventByEmail 同构：只做“发送”，重试/落行归 dispatch）：
 * 偏好/订阅存在性由 dispatch 核验；此处对每个 active 订阅投递一次。
 * 2xx → 更新 last_seen_at；404/410 → 立即删该订阅并抛 subscription_expired；
 * 429/5xx/网络错误 → 可重试 provider_unavailable；其余 4xx → provider_error（不重试）。
 */
export async function sendPush(env: Env, event: PushEventRef): Promise<void> {
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  if (!priv || !pub) {
    // §3.3：无 VAPID 密钥 → provider_unavailable 降级（不谎称已发送）
    throw new PushError("provider_unavailable", true);
  }

  const subs = await env.DB_PRIVATE.prepare(
    `SELECT subscription_id, endpoint, p256dh, auth
       FROM push_subscriptions
      WHERE user_id = ? AND status = 'active'`,
  )
    .bind(event.userId)
    .all<PushSubscriptionRow>();
  if (subs.results.length === 0) return; // 无有效订阅：跳过（dispatch 已核验，竞态兜底，不落行）

  const payload = utf8(JSON.stringify(await buildPushPayload(env, event)));
  const jwt = await signVapidJwt(env, subs.results[0]!.endpoint);

  let success = false;
  let sawTransient = false;
  let sawExpired = false;

  for (const sub of subs.results) {
    let body: Uint8Array;
    try {
      body = await encryptWebPush(payload, sub.p256dh, sub.auth);
    } catch (err) {
      if (err instanceof PushError && err.code === "provider_error") {
        continue; // 密钥形态非法（末尾统一抛 provider_error，不重试）
      }
      throw err;
    }
    let res: Response;
    try {
      res = await fetch(sub.endpoint, {
        method: "POST",
        headers: {
          Authorization: `vapid t=${jwt}, k=${pub}`,
          "Content-Type": "application/octet-stream",
          "Content-Encoding": "aes128gcm",
          TTL: "86400",
          Urgency: "normal",
        },
        body,
      });
    } catch {
      sawTransient = true; // 网络失败 → 可重试
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      // 成功：刷新 last_seen_at（cron 60 天清理依据）
      await env.DB_PRIVATE.prepare(
        "UPDATE push_subscriptions SET last_seen_at = datetime('now') WHERE subscription_id = ?",
      )
        .bind(sub.subscription_id)
        .run();
      success = true;
      continue;
    }
    if (res.status === 404 || res.status === 410) {
      // 拍板 3：订阅失效立即删除（只删行，不落 endpoint）
      await env.DB_PRIVATE.prepare(
        "DELETE FROM push_subscriptions WHERE subscription_id = ?",
      )
        .bind(sub.subscription_id)
        .run();
      sawExpired = true;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      sawTransient = true; // 瞬时失败 → dispatch 重试 1 次
      continue;
    }
    // 其他 4xx = 配置错误（不重试，末尾统一抛 provider_error）
  }

  if (success) return;
  if (sawTransient) throw new PushError("provider_unavailable", true);
  if (sawExpired) throw new PushError("subscription_expired", false);
  throw new PushError("provider_error", false);
}

// ---------------- cron：休眠订阅清理（拍板 3 后半） ----------------

/**
 * 清理超过 60 天未 last_seen_at 的 active 订阅，返回删除行数。
 * 由 index.ts scheduled 的 digest cron 分支独立 waitUntil 调用（独立 catch）。
 */
export async function cleanupStalePushSubscriptions(env: Env): Promise<number> {
  const res = await env.DB_PRIVATE.prepare(
    `DELETE FROM push_subscriptions
      WHERE status = 'active' AND last_seen_at < datetime('now', '-60 days')`,
  ).run();
  return res.meta.changes ?? 0;
}
