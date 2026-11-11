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
