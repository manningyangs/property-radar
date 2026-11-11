// TASK-02B：用户 API 验收——未登录禁止 /me/*；用户 A 无法读取/更新用户 B 的
// watch item/规则/事件；JSON Schema 校验与稳定错误码（PRD §TASK-02B 验收）。
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

const TOK_A = "tok-user-a";
const TOK_B = "tok-user-b";

function jsonHeaders(
  token?: string,
  contentType = "application/json",
): Record<string, string> {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(token ? { Cookie: authCookie(token) } : {}),
  };
}

async function createWatch(
  appInstance: ReturnType<typeof createApp>,
  env: TestContext["env"],
  token: string,
): Promise<string> {
  const res = await appInstance.request(
    "/api/v1/me/watch-items",
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({
        object_type: "region",
        object_id: `rgn_${token}`,
        display_name_snapshot: `测试区域-${token}（虚构）`,
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { item: { watch_id: string } };
  return body.item.watch_id;
}

beforeEach(async () => {
  ctx = createTestEnv();
  await seedUser(ctx.priv, "usr_a", "demo.a@example.com", TOK_A);
  await seedUser(ctx.priv, "usr_b", "demo.b@example.com", TOK_B);
  app = createApp();
});

describe("未登录不能访问 /me/*", () => {
  it("无 cookie 的代表性端点全部 401 unauthorized", async () => {
    const probes: Array<[string, string, string?]> = [
      ["GET", "/api/v1/me/watch-items"],
      ["POST", "/api/v1/me/watch-items"],
      ["GET", "/api/v1/me/events"],
      ["GET", "/api/v1/me/notification-preferences"],
      ["GET", "/api/v1/me/digests"],
      ["GET", "/api/v1/auth/me"],
    ];
    for (const [method, path] of probes) {
      const res = await app.request(
        path,
        {
          method,
          headers: jsonHeaders(undefined),
          body: method === "POST" ? "{}" : undefined,
        },
        ctx.env,
      );
      expect(res.status, `${method} ${path}`).toBe(401);
      const body = (await res.json()) as { error_code: string };
      expect(body.error_code).toBe("unauthorized");
    }
  });

  it("无效/过期会话 cookie 同样 401", async () => {
    const res = await app.request(
      "/api/v1/me/watch-items",
      { headers: { Cookie: "pr_session=not-a-real-token" } },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it("有效会话可访问并返回本人资料", async () => {
    const res = await app.request(
      "/api/v1/auth/me",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { user_id: string } };
    expect(body.user.user_id).toBe("usr_a");
  });
});

describe("用户 A 无法读取/更新用户 B 的数据", () => {
  it("列表隔离：A/B 各自只见自己的 watch item", async () => {
    await createWatch(app, ctx.env, TOK_A);
    const listA = await app.request(
      "/api/v1/me/watch-items",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    const bodyA = (await listA.json()) as {
      items: Array<{ user_id?: string; object_id: string }>;
    };
    expect(bodyA.items).toHaveLength(1);
    expect(bodyA.items[0]?.object_id).toBe(`rgn_${TOK_A}`);

    const listB = await app.request(
      "/api/v1/me/watch-items",
      { headers: jsonHeaders(TOK_B) },
      ctx.env,
    );
    const bodyB = (await listB.json()) as { items: unknown[] };
    expect(bodyB.items).toHaveLength(0);
  });

  it("B 读取/更新/删除 A 的 watch item 全部 404，A 本人可更新", async () => {
    const watchId = await createWatch(app, ctx.env, TOK_A);

    const bRead = await app.request(
      `/api/v1/me/watch-items/${watchId}`,
      { headers: jsonHeaders(TOK_B) },
      ctx.env,
    );
    expect(bRead.status).toBe(404);

    const bPatch = await app.request(
      `/api/v1/me/watch-items/${watchId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_B),
        body: JSON.stringify({ display_name_snapshot: "被篡改" }),
      },
      ctx.env,
    );
    expect(bPatch.status).toBe(404);

    const bDelete = await app.request(
      `/api/v1/me/watch-items/${watchId}`,
      { method: "DELETE", headers: jsonHeaders(TOK_B) },
      ctx.env,
    );
    expect(bDelete.status).toBe(404);

    // A 本人可更新，且显示名未被 B 篡改
    const aPatch = await app.request(
      `/api/v1/me/watch-items/${watchId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({ display_name_snapshot: "A-改名", priority: 5 }),
      },
      ctx.env,
    );
    expect(aPatch.status).toBe(200);
    const patched = (await aPatch.json()) as {
      item: { display_name_snapshot: string; priority: number };
    };
    expect(patched.item.display_name_snapshot).toBe("A-改名");
    expect(patched.item.priority).toBe(5);
  });

  it("B 无法向 A 的 watch item 下发规则，也不能改 A 的规则", async () => {
    const watchId = await createWatch(app, ctx.env, TOK_A);
    const aRule = await app.request(
      `/api/v1/me/watch-items/${watchId}/rules`,
      {
        method: "POST",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({
          rule_type: "price_below",
          metric_code: "median_unit_price",
          target_value: 20000,
          unit: "yuan_sqm",
        }),
      },
      ctx.env,
    );
    expect(aRule.status).toBe(201);
    const ruleId = ((await aRule.json()) as { item: { rule_id: string } }).item
      .rule_id;

    const bRule = await app.request(
      `/api/v1/me/watch-items/${watchId}/rules`,
      {
        method: "POST",
        headers: jsonHeaders(TOK_B),
        body: JSON.stringify({ rule_type: "price_below", metric_code: "m" }),
      },
      ctx.env,
    );
    expect(bRule.status).toBe(404);

    const bPatchRule = await app.request(
      `/api/v1/me/rules/${ruleId}`,
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_B),
        body: JSON.stringify({ target_value: 1 }),
      },
      ctx.env,
    );
    expect(bPatchRule.status).toBe(404);

    const bDeleteRule = await app.request(
      `/api/v1/me/rules/${ruleId}`,
      { method: "DELETE", headers: jsonHeaders(TOK_B) },
      ctx.env,
    );
    expect(bDeleteRule.status).toBe(404);
  });

  it("事件隔离：B 无法标记 A 的事件已读，事件列表互不可见", async () => {
    ctx.priv
      .prepare(
        `INSERT INTO alert_events (event_id, user_id, event_key, event_type, old_value, new_value)
         VALUES ('evt_a', 'usr_a', 'key-a', 'price_crossed', 21000, 19500)`,
      )
      .run();
    const bRead = await app.request(
      "/api/v1/me/events/evt_a/read",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_B),
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(bRead.status).toBe(404);

    const aList = await app.request(
      "/api/v1/me/events",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    const aEvents = (await aList.json()) as { count: number };
    expect(aEvents.count).toBe(1);

    const bList = await app.request(
      "/api/v1/me/events",
      { headers: jsonHeaders(TOK_B) },
      ctx.env,
    );
    expect(((await bList.json()) as { count: number }).count).toBe(0);

    const aRead = await app.request(
      "/api/v1/me/events/evt_a/read",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(aRead.status).toBe(200);
  });
});

describe("JSON Schema 校验与稳定错误码", () => {
  it("缺字段/多字段/枚举错误 → 400 validation_failed", async () => {
    const cases = [
      { object_type: "region" }, // 缺必填
      {
        object_type: "planet", // 枚举外
        object_id: "x",
        display_name_snapshot: "x",
      },
      {
        object_type: "region",
        object_id: "x",
        display_name_snapshot: "x",
        unknown_field: 1, // additionalProperties
      },
    ];
    for (const body of cases) {
      const res = await app.request(
        "/api/v1/me/watch-items",
        {
          method: "POST",
          headers: jsonHeaders(TOK_A),
          body: JSON.stringify(body),
        },
        ctx.env,
      );
      expect(res.status).toBe(400);
      const parsed = (await res.json()) as {
        error_code: string;
        details?: unknown[];
      };
      expect(parsed.error_code).toBe("validation_failed");
      expect(parsed.details?.length).toBeGreaterThan(0);
      // 校验错误不回显用户提交的值
      expect(JSON.stringify(parsed)).not.toContain("planet");
    }
  });

  it("非 JSON Content-Type → 415；非法 JSON → 400", async () => {
    const notJson = await app.request(
      "/api/v1/me/watch-items",
      {
        method: "POST",
        headers: jsonHeaders(TOK_A, "text/plain"),
        body: "object_type=region",
      },
      ctx.env,
    );
    expect(notJson.status).toBe(415);

    const broken = await app.request(
      "/api/v1/me/watch-items",
      {
        method: "POST",
        headers: jsonHeaders(TOK_A),
        body: "{not json",
      },
      ctx.env,
    );
    expect(broken.status).toBe(400);
    expect(((await broken.json()) as { error_code: string }).error_code).toBe(
      "bad_request",
    );
  });

  it("同一用户重复添加同一对象 → 409 conflict（不泄露 SQL）", async () => {
    await createWatch(app, ctx.env, TOK_A);
    const dup = await app.request(
      "/api/v1/me/watch-items",
      {
        method: "POST",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({
          object_type: "region",
          object_id: `rgn_${TOK_A}`,
          display_name_snapshot: "重复",
        }),
      },
      ctx.env,
    );
    expect(dup.status).toBe(409);
    const text = await dup.text();
    expect(text).toContain('"error_code":"conflict"');
    expect(text).not.toMatch(/UNIQUE|sqlite|INSERT/i);
  });

  it("通知偏好 PATCH 校验 digest_time 格式，GET 返回默认值", async () => {
    const def = await app.request(
      "/api/v1/me/notification-preferences",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    const defBody = (await def.json()) as {
      preferences: { email_enabled: boolean; digest_time: string };
    };
    expect(defBody.preferences.email_enabled).toBe(true);
    expect(defBody.preferences.digest_time).toBe("07:30");

    const bad = await app.request(
      "/api/v1/me/notification-preferences",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({ digest_time: "25:99" }),
      },
      ctx.env,
    );
    expect(bad.status).toBe(400);

    const ok = await app.request(
      "/api/v1/me/notification-preferences",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({ digest_time: "08:00", email_enabled: false }),
      },
      ctx.env,
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as {
      preferences: { digest_time: string; email_enabled: boolean };
    };
    expect(okBody.preferences.digest_time).toBe("08:00");
    expect(okBody.preferences.email_enabled).toBe(false);
  });

  it("未实现端点（export/delete-account）返回 501 not_implemented", async () => {
    const res = await app.request(
      "/api/v1/me/export",
      {
        method: "POST",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error_code: string }).error_code).toBe(
      "not_implemented",
    );
  });
});

describe("会话管理辅助", () => {
  it("种子会话对私有库可见（确保测试基础正确）", () => {
    const rows = ctx.priv
      .prepare("SELECT user_id FROM sessions")
      .all() as Array<{ user_id: string }>;
    expect(rows.map((r) => r.user_id).sort()).toEqual(["usr_a", "usr_b"]);
  });
});
