// TASK-02B：结构化访问日志与脱敏（PRD §12.0-5：日志不得输出真实邮箱/Token/验证码）

/** 键名命中即视为敏感，字符串值整体打码 */
const SENSITIVE_KEY =
  /(email|token|secret|password|passwd|code|cookie|authorization|session|otp|otp_hash|api_key)/i;

/** 值中出现的邮箱形态一律打码（即使键名不敏感） */
const EMAIL_IN_VALUE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/**
 * 深度脱敏：敏感键的字符串值 → "[redacted]"；值中的邮箱 → "***"。
 * 用于所有错误日志；访问日志只记录路径不记录查询串。
 */
export function redact<T>(value: T, keyHint = ""): T {
  if (typeof value === "string") {
    if (SENSITIVE_KEY.test(keyHint)) return "[redacted]" as unknown as T;
    return value.replace(EMAIL_IN_VALUE, "***") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, keyHint)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        SENSITIVE_KEY.test(k) && typeof v === "string"
          ? "[redacted]"
          : redact(v, k);
    }
    return out as unknown as T;
  }
  return value;
}

/** 访问日志：仅记录 pathname（丢弃查询串，查询参数可能携带邮箱等敏感值） */
export function logAccess(record: {
  request_id: string;
  method: string;
  url: string;
  status: number;
  duration_ms: number;
  ip: string;
}): void {
  let pathname = record.url;
  try {
    pathname = new URL(record.url).pathname;
  } catch {
    // url 非法时保留原值（仍不含查询串处理能力，交由脱敏）
  }
  console.log(
    JSON.stringify(
      redact({
        level: "info",
        evt: "http_request",
        request_id: record.request_id,
        method: record.method,
        path: pathname,
        status: record.status,
        duration_ms: record.duration_ms,
        ip: record.ip,
      }),
    ),
  );
}

/** 错误日志：消息与栈均经脱敏后输出（仅服务端可见） */
export function logError(record: {
  request_id: string;
  message: string;
  stack?: string;
}): void {
  console.error(
    JSON.stringify(
      redact({ level: "error", evt: "unhandled_error", ...record }),
    ),
  );
}
