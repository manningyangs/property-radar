// TASK-02B：API 框架基础验收——健康检查、统一错误信封、请求 ID、CORS 白名单、
// 限流、日志脱敏（PRD §10 / §TASK-02B 要求）。
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { redact } from "./log";
import { createTestEnv } from "./test-utils/setup";

describe("健康检查与错误信封", () => {
  it("GET /api/health 返回 200 与服务名", async () => {
    const { env } = createTestEnv();
    const app = createApp();
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("property-radar-api");
  });

  it("未知路径返回 404 统一信封（error_code + request_id），且与响应头一致", async () => {
    const { env } = createTestEnv();
    const app = createApp();
    const res = await app.request("/api/v1/nope", {}, env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "error_code",
      "message",
      "request_id",
    ]);
    expect(body.error_code).toBe("not_found");
    expect(res.headers.get("X-Request-Id")).toBe(body.request_id);
  });

  it("内部错误不泄露 SQL/表结构，只返回稳定 internal_error", async () => {
    const { env } = createTestEnv();
    const app = createApp();
    // 未迁移的空库 → 查询报错 → 500 信封
    const bare = {
      ...env,
      DB_PUBLIC: env.DB_PUBLIC, // 保持绑定，但访问缺表列触发错误
    };
    // 使用未建表的库模拟内部错误
    const { DatabaseSync } = await import("node:sqlite");
    const { createFakeD1 } = await import("./test-utils/fake-d1");
    const empty = new DatabaseSync(":memory:");
    const res = await app.request(
      "/api/v1/public/system/status",
      {},
      { ...bare, DB_PUBLIC: createFakeD1(empty) },
    );
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain('"error_code":"internal_error"');
    expect(text).not.toMatch(/sqlite|no such table|SELECT/i);
  });
});

describe("CORS 白名单", () => {
  const allowed = "https://radar.example.com";

  it("白名单 Origin 放行且允许 credentials", async () => {
    const { env } = createTestEnv();
    env.CORS_ALLOWED_ORIGINS = allowed;
    const app = createApp();
    const res = await app.request(
      "/api/health",
      { headers: { Origin: allowed } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(allowed);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  it("非白名单 Origin 不返回放行头", async () => {
    const { env } = createTestEnv();
    env.CORS_ALLOWED_ORIGINS = allowed;
    const app = createApp();
    const res = await app.request(
      "/api/health",
      { headers: { Origin: "https://evil.example.org" } },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("预检 OPTIONS 返回 204", async () => {
    const { env } = createTestEnv();
    env.CORS_ALLOWED_ORIGINS = allowed;
    const app = createApp();
    const res = await app.request(
      "/api/v1/me/watch-items",
      {
        method: "OPTIONS",
        headers: { Origin: allowed, "Access-Control-Request-Method": "POST" },
      },
      env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

describe("限流", () => {
  it("超过配额返回 429 rate_limited + Retry-After，换 IP 恢复", async () => {
    const { env } = createTestEnv();
    env.RATE_LIMIT_MAX = "3";
    env.RATE_LIMIT_WINDOW_SEC = "60";
    const app = createApp();
    const ip = "203.0.113.7";
    for (let i = 0; i < 3; i += 1) {
      const ok = await app.request(
        "/api/health",
        {
          headers: { "cf-connecting-ip": ip },
        },
        env,
      );
      expect(ok.status).toBe(200);
    }
    const blocked = await app.request(
      "/api/health",
      {
        headers: { "cf-connecting-ip": ip },
      },
      env,
    );
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { error_code: string };
    expect(body.error_code).toBe("rate_limited");
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);

    const other = await app.request(
      "/api/health",
      {
        headers: { "cf-connecting-ip": "198.51.100.9" },
      },
      env,
    );
    expect(other.status).toBe(200);
  });
});

describe("日志脱敏（PRD §12.0-5）", () => {
  it("redact 打码敏感键与值中的邮箱", () => {
    const out = redact({
      email: "user@example.com",
      token: "super-secret",
      nested: { otp: "123456", note: "联系 alice@example.com" },
      count: 3,
    });
    expect(JSON.stringify(out)).not.toContain("user@example.com");
    expect(JSON.stringify(out)).not.toContain("super-secret");
    expect(JSON.stringify(out)).not.toContain("123456");
    expect(JSON.stringify(out)).not.toContain("alice@example.com");
    expect(out.count).toBe(3);
  });

  it("访问日志只记录路径，不落查询串中的邮箱/Token", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const { env } = createTestEnv();
      const app = createApp();
      await app.request(
        "/api/health?email=leak@example.com&token=abc123",
        { headers: { "cf-connecting-ip": "203.0.113.10" } },
        env,
      );
      const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain("http_request");
      expect(logged).not.toContain("leak@example.com");
      expect(logged).not.toContain("abc123");
      expect(logged).toContain("/api/health");
    } finally {
      spy.mockRestore();
    }
  });
});
