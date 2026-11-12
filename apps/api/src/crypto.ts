// TASK-02C：Web Crypto 哈希工具——会话 token 与 OTP 只存哈希（PRD §7.1/§9.2）。
// Worker 运行时与 Node 22 测试环境均提供全局 crypto.subtle，零依赖。

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 十六进制（浏览器只持随机 token，库存哈希） */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return toHex(digest);
}

/** HMAC-SHA256 十六进制（OTP 码哈希与 Apps Script 网关签名共用） */
export async function hmacSha256Hex(
  key: string,
  message: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return toHex(signature);
}

/** 定长摘要的简单常量时间比较（长度不同直接 false；均为固定长度 hex） */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
