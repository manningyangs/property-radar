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
  /** TASK-04A：internal 批次端点 HMAC 签名密钥（Secret；缺省 = 端点整体禁用 ingest_disabled） */
  INGEST_HMAC_SECRET?: string;
  /** 邮件服务商实现名，V1 仅 google_apps_script_mail（非敏感 vars） */
  EMAIL_PROVIDER?: string;
  /** 邮件总硬上限（收件人/滚动24小时，缺省 80） */
  EMAIL_DAILY_HARD_CAP?: string;
  /** OTP 每日预留上限（缺省 60） */
  OTP_DAILY_RESERVED_CAP?: string;
  /** TASK-05B：前端站点根地址（邮件内页链接用；缺省本地开发地址） */
  WEB_BASE_URL?: string;
  // ---- TASK-05C：浏览器推送 VAPID（RFC 8296） ----
  /** VAPID ES256 私钥：PKCS#8 DER 的 base64url（Secret；缺失时推送走 provider_unavailable 降级） */
  VAPID_PRIVATE_KEY?: string;
  /** VAPID 公钥：P-256 未压缩点 65 字节的 base64url（非机密；经 GET /public/push-config 分发给浏览器作 applicationServerKey） */
  VAPID_PUBLIC_KEY?: string;
  /** VAPID JWT 的 sub（mailto: 或 https: 联系方式；缺省 mailto:admin@example.com） */
  VAPID_SUBJECT?: string;
  // ---- TASK-06A：后台认证与权限 ----
  /** 首次创建管理员的初始化代码（Secret；缺省 = bootstrap 端点禁用 503。创建成功后应立即撤销/删除该值） */
  ADMIN_BOOTSTRAP_CODE?: string;
}

export type AppEnv = {
  Bindings: Env;
  Variables: {
    requestId: string;
    userId: string;
    /** TASK-06A：当前会话 ID（requireSession 填充，管理员 MFA 会话标记按它校验） */
    sessionId: string;
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
