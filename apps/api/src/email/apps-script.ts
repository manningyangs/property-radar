// TASK-02C：Google Apps Script MailApp 网关适配器（PRD §7.1「Apps Script Gateway 安全设计」）。
// Worker → Apps Script Web App 的调用必须 HMAC 签名：签名覆盖方法、完整 body、
// 时间戳与随机 request_id；时间偏差 ≤60 秒；request_id 防重放。
// 网关只执行固定模板发送，所有认证判断留在 Worker（本文件不参与 OTP 校验）。
import { hmacSha256Hex } from "../crypto";
import { type Env } from "../env";
import {
  EmailProviderError,
  type DigestMail,
  type EmailProvider,
  type EventMail,
  type OtpMail,
} from "./provider";

/** 时间戳允许偏差（秒），与 Apps Script 端校验保持一致 */
export const GATEWAY_MAX_SKEW_SEC = 60;

/** 网关签名规范串：方法、完整 body、时间戳、request_id（PRD §7.1） */
export function gatewayCanonical(
  method: string,
  body: string,
  timestamp: string,
  requestId: string,
): string {
  return [method, body, timestamp, requestId].join("\n");
}

export class GoogleAppsScriptMailProvider implements EmailProvider {
  readonly name = "google_apps_script_mail";

  constructor(private readonly env: Env) {}

  /**
   * 经 HMAC 网关发送固定模板（签名与错误分类同 02C sendOtp）：
   * 签名覆盖方法、完整 body、时间戳与随机 request_id；失败抛 EmailProviderError 分类码。
   */
  private async postTemplate(payload: Record<string, unknown>): Promise<void> {
    const url = this.env.APPS_SCRIPT_WEB_APP_URL?.trim();
    const secret = this.env.APPS_SCRIPT_HMAC_SECRET?.trim();
    if (!url || !secret) {
      throw new EmailProviderError("gateway_not_configured");
    }
    const requestId = crypto.randomUUID();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload);
    const signature = await hmacSha256Hex(
      secret,
      gatewayCanonical("POST", body, timestamp, requestId),
    );

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PR-Request-Id": requestId,
          "X-PR-Timestamp": timestamp,
          "X-PR-Signature": signature,
        },
        body,
      });
    } catch {
      throw new EmailProviderError("gateway_unreachable");
    }
    if (!res.ok) throw new EmailProviderError(`gateway_status_${res.status}`);
    const data = (await res.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!data || data.ok !== true) {
      // 例如 MailApp.getRemainingDailyQuota() 为 0 时网关拒绝（quota_exhausted）
      throw new EmailProviderError(data?.error ?? "gateway_rejected");
    }
  }

  async sendOtp(mail: OtpMail): Promise<void> {
    await this.postTemplate({
      template: "otp",
      to: mail.to,
      code: mail.code,
      ttl_minutes: mail.ttlMinutes,
    });
  }

  async sendEvent(mail: EventMail): Promise<void> {
    const { to, ...content } = mail;
    await this.postTemplate({ template: "price_alert", to, ...content });
  }

  async sendDigest(mail: DigestMail): Promise<void> {
    const { to, ...content } = mail;
    await this.postTemplate({ template: "daily_digest", to, ...content });
  }
}
