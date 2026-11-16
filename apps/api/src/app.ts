// TASK-02B：应用装配——请求 ID、CORS 白名单、限流、访问日志、统一错误信封（PRD §10）
import { Hono } from "hono";
import { AppError, errorEnvelope } from "./errors";
import { allowedOrigins, envInt, type AppEnv } from "./env";
import { logAccess, logError } from "./log";
import { clientIp, FixedWindowRateLimiter } from "./rate-limit";
import { authRoutes } from "./routes/auth";
import { meRoutes } from "./routes/me";
import { adminRoutes } from "./routes/admin";
import { adminAuthRoutes } from "./routes/admin-auth"; // TASK-06A：bootstrap / mfa/* / audit
import { adminUsersRoutes } from "./routes/admin-users"; // TASK-06B：overview / users
import { adminOpsRoutes } from "./routes/admin-ops"; // TASK-06D：jobs / quality/issues
import { internalRoutes } from "./routes/internal";
import { publicRoutes } from "./routes/public";

const RATE_DEFAULT_MAX = 120;
const RATE_DEFAULT_WINDOW_SEC = 60;

export function createApp(): Hono<AppEnv> {
  // 限流状态挂在 app 实例上（每个 Worker isolate / 测试实例独立）
  const limiter = new FixedWindowRateLimiter();
  const app = new Hono<AppEnv>();

  // 1) 请求 ID：每个请求生成新的 UUID，写入响应头并贯穿日志与错误信封
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.header("X-Request-Id", c.get("requestId"));
    await next();
  });

  // 2) CORS 白名单：仅白名单 Origin 附带放行头（含 credentials），其余不放行
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin && allowedOrigins(c.env).includes(origin)) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Vary", "Origin");
      c.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
      );
      c.header("Access-Control-Allow-Headers", "Content-Type");
      c.header("Access-Control-Max-Age", "600");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
    return undefined;
  });

  // 3) 限流：按 IP 固定窗口，超限 429 + Retry-After（免费额度内，进程内存实现）
  app.use("*", async (c, next) => {
    const ip = clientIp((name) => c.req.header(name));
    const max = envInt(c.env.RATE_LIMIT_MAX, RATE_DEFAULT_MAX);
    const windowSec = envInt(
      c.env.RATE_LIMIT_WINDOW_SEC,
      RATE_DEFAULT_WINDOW_SEC,
    );
    const result = limiter.check(ip, { max, windowSec });
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSec));
      return c.json(
        errorEnvelope(
          c.get("requestId") ?? "",
          "rate_limited",
          "请求过于频繁，请稍后重试",
        ),
        429,
      );
    }
    c.header("X-RateLimit-Remaining", String(result.remaining));
    await next();
    return undefined;
  });

  // 4) 访问日志：结构化 JSON，只记路径不记查询串，IP/字段经脱敏（PRD §12.0-5）
  app.use("*", async (c, next) => {
    const started = Date.now();
    await next();
    logAccess({
      request_id: c.get("requestId") ?? "",
      method: c.req.method,
      url: c.req.url,
      status: c.res.status,
      duration_ms: Date.now() - started,
      ip: clientIp((name) => c.req.header(name)),
    });
  });

  // 兼容 TASK-01A 的健康检查
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      service: "property-radar-api",
      time: new Date().toISOString(),
    }),
  );

  // PRD §10 统一前缀 /api/v1
  app.route("/api/v1/public", publicRoutes);
  app.route("/api/v1/me", meRoutes);
  // TASK-04A：管理端（requireAdminAccess 统一门禁）与 internal 批次端点（HMAC）
  app.route("/api/v1/admin", adminRoutes);
  // TASK-06A：须在 adminRoutes 之后挂载——其 use("*") 先行匹配，bootstrap/mfa 豁免规则生效
  app.route("/api/v1/admin", adminAuthRoutes);
  // TASK-06B：系统总览与用户管理（requireAdminAccess 统一门禁，无豁免路径）
  app.route("/api/v1/admin", adminUsersRoutes);
  // TASK-06D：任务与质量只读端点（jobs / quality/issues，requireAdminAccess 统一门禁）
  app.route("/api/v1/admin", adminOpsRoutes);
  app.route("/api/v1/internal", internalRoutes);
  app.route("/api/v1/auth", authRoutes);

  app.notFound((c) =>
    c.json(
      errorEnvelope(c.get("requestId") ?? "", "not_found", "资源不存在"),
      404,
    ),
  );

  // 5) 统一错误信封：AppError 按稳定 error_code 返回；其余一律 500，
  //    内部错误信息只进服务端日志（脱敏后），绝不下发 SQL/表结构
  app.onError((err, c) => {
    const requestId = c.get("requestId") ?? "";
    if (err instanceof AppError) {
      return c.json(
        errorEnvelope(requestId, err.errorCode, err.message, err.details),
        err.status,
      );
    }
    logError({
      request_id: requestId,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json(
      errorEnvelope(requestId, "internal_error", "服务器内部错误"),
      500,
    );
  });

  return app;
}
