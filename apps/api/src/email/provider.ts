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

/**
 * TASK-05B R1.2：事件邮件正文（九要素，全部为展示就绪的中文文案）。
 * 字段名与取值均不使用内部字段名/表名/列名（PRD 任务行 1332 验收）。
 */
export interface EventMailContent {
  subject: string;
  /** 对象名称 */
  object_name: string;
  /** 指标中文名 */
  metric_name: string;
  /** 目标值（或跌幅阈值） */
  target: string;
  /** 当前值 */
  current: string;
  /** 价差（数值与百分比） */
  gap: string;
  /** 数据统计日期 */
  date: string;
  /** 来源名称 */
  source: string;
  /** 样本量 */
  samples: string;
  /** 站内页面链接 */
  link: string;
}

/** 事件邮件（price_alert 模板） */
export interface EventMail extends EventMailContent {
  to: string;
}

/** 每日摘要邮件（daily_digest 模板）正文：概述行 + 事件明细行 + 页面链接 */
export interface DigestMail {
  to: string;
  subject: string;
  /** 摘要日期（北京） */
  date: string;
  /** 概述行（昨日价格变化/事件/监控与数据状态） */
  summary_lines: string[];
  /** 事件明细行（对象、类型、变化摘要、链接） */
  event_rows: Array<{
    object_name: string;
    type_label: string;
    change_summary: string;
    link: string;
  }>;
  /** 事件中心页面链接 */
  link: string;
}

export interface EmailProvider {
  readonly name: string;
  /** 发送登录验证码；失败抛 EmailProviderError（消息不含验证码/邮箱） */
  sendOtp(mail: OtpMail): Promise<void>;
  /** 发送事件提醒邮件（price_alert）；失败抛 EmailProviderError */
  sendEvent(mail: EventMail): Promise<void>;
  /** 发送每日摘要邮件（daily_digest）；失败抛 EmailProviderError */
  sendDigest(mail: DigestMail): Promise<void>;
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
