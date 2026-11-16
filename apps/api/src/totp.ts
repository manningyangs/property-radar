// TASK-06A：TOTP 引擎（RFC 6238 / RFC 4648 Base32）
// 口径：SHA-1 HMAC、30s 步长、6 位十进制、窗口 ±1（当前及前后各 1 步共 3 步容差）。
// 零新依赖：HMAC 走 WebCrypto（crypto.subtle，Workers/Node 22 全局可用）；
// 返回「通过的 step」由调用方与 admin_mfa_secrets.last_used_step 比较做防重放。

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;
const DIGITS = 6;
const MODULO = 10 ** DIGITS;

/** RFC 4648 Base32 解码：容忍小写与 padding；遇非法字符抛错（调用方映射 mfa_invalid_code） */
export function base32Decode(input: string): Uint8Array {
  const cleaned = input.replace(/=+$/u, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** RFC 4648 Base32 编码（无 padding，20 字节 → 32 字符，天然 8 的倍数） */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** 生成 160-bit 随机密钥（RFC 6238 §4 建议 SHA-1 用 160 bit）→ base32 */
export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

/** T0 = 0（Unix epoch），X = 30s；step = floor((unix秒) / 30) */
export function stepOf(timeMs: number): number {
  return Math.floor(timeMs / STEP_MS);
}

/** 指定 step 的 6 位验证码（动态截断，RFC 6238 §5.3） */
export async function totpCodeAt(
  secretBase32: string,
  step: number,
): Promise<string> {
  const key = base32Decode(secretBase32);
  const counter = new Uint8Array(8);
  // step 最大 2^53 安全；大端写入
  let high = Math.floor(step / 2 ** 32);
  let low = step >>> 0;
  for (let i = 7; i >= 4; i--) {
    counter[i] = low & 0xff;
    low = Math.floor(low / 256);
  }
  for (let i = 3; i >= 0; i--) {
    counter[i] = high & 0xff;
    high = Math.floor(high / 256);
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      counter as unknown as BufferSource,
    ),
  );
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    (((mac[offset + 1] ?? 0) & 0xff) << 16) |
    (((mac[offset + 2] ?? 0) & 0xff) << 8) |
    ((mac[offset + 3] ?? 0) & 0xff);
  return String((binary >>> 0) % MODULO).padStart(DIGITS, "0");
}

/** 当前时刻的验证码（供测试与客户端对表） */
export function generate(
  secretBase32: string,
  timeMs: number = Date.now(),
): Promise<string> {
  return totpCodeAt(secretBase32, stepOf(timeMs));
}

/**
 * 校验验证码（窗口 ±1）。
 * 返回通过的 step；调用方必须用 step > last_used_step 判定防重放。
 * 常量时间比较：窗口三步全部计算，不因提前命中而短路。
 */
export async function verify(
  secretBase32: string,
  code: string,
  timeMs: number = Date.now(),
  window = 1,
): Promise<{ ok: boolean; step?: number }> {
  if (!/^\d{6}$/u.test(code)) return { ok: false };
  const center = stepOf(timeMs);
  let match = -1;
  let score = 0;
  for (let w = -window; w <= window; w++) {
    const step = center + w;
    const expected = await totpCodeAt(secretBase32, step);
    let diff = 0;
    for (let i = 0; i < DIGITS; i++) {
      diff |= expected.charCodeAt(i) ^ code.charCodeAt(i);
    }
    // 常量时间：不 break，累计命中（同码撞多步时取最小 step，重放判定由 step 比较兜底）
    const hit = diff === 0 ? 1 : 0;
    score += hit;
    if (hit === 1 && match === -1) match = step;
  }
  return score > 0 ? { ok: true, step: match } : { ok: false };
}

/** otpauth:// URI（authenticator 扫码用） */
export function otpauthUri(
  secretBase32: string,
  account: string,
  issuer = "Property Radar",
): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_MS / 1000),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
