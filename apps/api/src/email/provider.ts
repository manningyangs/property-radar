// TASK-02C：EmailProvider 统一接口（PRD §7.1「所有邮件服务封装统一 EmailProvider 接口」）。
// 认证业务只依赖本接口；Apps Script Web App URL 与供应商细节封装在实现内，
// 不允许与认证路由耦合。V1 仅启用 google_apps_script_mail；Brevo/Resend
// 为后续经负责人批准并完成域名认证后的迁移适配器，不在本任务实现。
import { errors } from "../errors";
import { type Env } from "../env";
import { GoogleAppsScriptMailProvider } from "./apps-script";

export interface OtpMail {
  /** 收件邮箱（明文仅在请求链路内传递，不落日志） */
  to: string;
  /** 六位验证码（同上，禁止进入任何持久化与日志） */
  code: string;
  ttlMinutes: number;
}

export interface EmailProvider {
  readonly name: string;
  /** 发送登录验证码；失败抛 EmailProviderError（消息不含验证码/邮箱） */
  sendOtp(mail: OtpMail): Promise<void>;
}

/** 邮件网关失败（网络/配额/验签拒绝）；reason 为无敏感信息的分类码 */
export class EmailProviderError extends Error {
  constructor(reason: string) {
    super(`email_provider_failure:${reason}`);
    this.name = "EmailProviderError";
  }
}

export function createEmailProvider(env: Env): EmailProvider {
  const provider = (env.EMAIL_PROVIDER ?? "google_apps_script_mail").trim();
  switch (provider) {
    case "google_apps_script_mail":
      return new GoogleAppsScriptMailProvider(env);
    default:
      // 未知实现名视为配置错误，绝不回退到付费或未审批服务（PRD §6 免费红线）
      throw errors.unavailable("邮件服务配置无效");
  }
}
