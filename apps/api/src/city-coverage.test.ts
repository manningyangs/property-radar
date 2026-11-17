// TASK-08C R6b：POST /me/city-coverage-requests——成功/重复 409/非法城市 400。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import {
  authCookie,
  createTestEnv,
  seedUser,
  type TestContext,
} from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const TOK = "tok-cc";

beforeEach(async () => {
  ctx = createTestEnv();
  await seedUser(ctx.priv, "usr_cc", "cc@example.com", TOK);
  // 目录种子：active（已开通）/ requestable（可申请）/ disabled（目录停用）
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status, catalog_status) VALUES ('C100000', '已开通城', 'P110000', 'active', 'active')",
    )
    .run();
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status, catalog_status) VALUES ('C200000', '可申请城', 'P120000', 'requestable', 'active')",
    )
    .run();
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status, catalog_status) VALUES ('C300000', '停用城', 'P130000', 'requestable', 'disabled')",
    )
    .run();
  app = createApp();
});

async function post(
  payload: Record<string, unknown>,
  token = TOK,
): Promise<Response> {
  return app.request(
    "/api/v1/me/city-coverage-requests",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: authCookie(token),
      },
      body: JSON.stringify(payload),
    },
    ctx.env,
  );
}

describe("POST /me/city-coverage-requests", () => {
  it("未登录 → 401", async () => {
    const res = await app.request(
      "/api/v1/me/city-coverage-requests",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requested_city_name: "随便城" }),
      },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it("requestable 城市提交成功 → 201 submitted", async () => {
    const res = await post({
      city_code: "C200000",
      requested_city_name: "可申请城",
      reason: "希望关注这里的房价",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      request: { city_code: string; status: string };
    };
    expect(body.request.city_code).toBe("C200000");
    expect(body.request.status).toBe("submitted");
    const row = ctx.priv
      .prepare(
        "SELECT user_id, reason FROM city_coverage_requests WHERE city_code = 'C200000'",
      )
      .get() as { user_id: string; reason: string };
    expect(row.user_id).toBe("usr_cc");
    expect(row.reason).toBe("希望关注这里的房价");
  });

  it("同人同城重复提交 → 409 already_requested", async () => {
    const first = await post({
      city_code: "C200000",
      requested_city_name: "可申请城",
    });
    expect(first.status).toBe(201);
    const again = await post({
      city_code: "C200000",
      requested_city_name: "可申请城",
    });
    expect(again.status).toBe(409);
    const body = (await again.json()) as { error_code: string };
    expect(body.error_code).toBe("already_requested");
  });

  it("非法城市（不在目录/目录停用）→ 400 validation_failed", async () => {
    for (const code of ["C999999", "C300000"]) {
      const res = await post({
        city_code: code,
        requested_city_name: "未知城",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("validation_failed");
    }
  });

  it("已开通城市无需申请 → 400", async () => {
    const res = await post({
      city_code: "C100000",
      requested_city_name: "已开通城",
    });
    expect(res.status).toBe(400);
  });

  it("未知城市（仅名称）可提交；同名重复 → 409", async () => {
    const first = await post({ requested_city_name: "县城A" });
    expect(first.status).toBe(201);
    const again = await post({ requested_city_name: "县城A" });
    expect(again.status).toBe(409);
    const row = ctx.priv
      .prepare(
        "SELECT city_code FROM city_coverage_requests WHERE requested_city_name = '县城A'",
      )
      .get() as { city_code: string | null };
    expect(row.city_code).toBeNull();
  });

  it("缺少城市名称 → 400（schema 校验）", async () => {
    const res = await post({ city_code: "C200000" });
    expect(res.status).toBe(400);
  });
});
