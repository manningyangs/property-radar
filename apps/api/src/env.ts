// TASK-02B：Worker 环境绑定与 Hono 应用上下文类型（PRD §10 API 框架）
import type { D1Database } from "@cloudflare/workers-types";

/** Worker 绑定与可配置项（均可通过 wrangler.jsonc vars / secrets 覆盖） */
export interface Env {
  DB_PUBLIC: D1Database;
  DB_PRIVATE: D1Database;
  /** CORS 白名单，逗号分隔的 Origin；缺省仅允许本地开发地址 */
  CORS_ALLOWED_ORIGINS?: string;
  /** 每 IP 每窗口允许请求数（缺省 120） */
  RATE_LIMIT_MAX?: string;
  /** 限流窗口秒数（缺省 60） */
  RATE_LIMIT_WINDOW_SEC?: string;
  // ---- TASK-02C：认证与邮件（Secrets 用 wrangler secret 配置，不得入库/入前端） ----
  /** OTP/指纹 HMAC 密钥（Secret，PRD 附录 A：SESSION_SIGNING_SECRET） */
  SESSION_SIGNING_SECRET?: string;
  /** Cloudflare Turnstile 服务端校验密钥（Secret） */
  TURNSTILE_SECRET_KEY?: string;
  /** Apps Script Web App 地址（Secret，禁止写入前端或仓库） */
  APPS_SCRIPT_WEB_APP_URL?: string;
  /** 与 Apps Script Script Properties 一致的共享签名密钥（Secret） */
  APPS_SCRIPT_HMAC_SECRET?: string;
  /** 邮件服务商实现名，V1 仅 google_apps_script_mail（非敏感 vars） */
  EMAIL_PROVIDER?: string;
  /** 邮件总硬上限（收件人/滚动24小时，缺省 80） */
  EMAIL_DAILY_HARD_CAP?: string;
  /** OTP 每日预留上限（缺省 60） */
  OTP_DAILY_RESERVED_CAP?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    userId: string;
  };
};

/** 会话 cookie 名（TASK-02C 登录时签发） */
export const SESSION_COOKIE = "pr_session";

/** 解析正整数环境变量（缺失/非法时回退默认值） */
export function envInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 默认 CORS 白名单：本地 Astro 开发服务器 */
export const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:4321"];

export function allowedOrigins(env: Env): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS?.trim();
  if (!raw) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
