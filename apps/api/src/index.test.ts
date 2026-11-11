import { describe, expect, it } from "vitest";
import app from "./index";

describe("api health", () => {
  it("GET /api/health 返回 200 与服务名", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe("ok");
    expect(body.service).toBe("property-radar-api");
  });

  it("未知路径返回 404 结构化错误", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; code: number };
    expect(body.error).toBe("not_found");
    expect(body.code).toBe(404);
  });
});
