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

/** TASK-03B：创建 community 类型的 watch item（规则只允许挂在 community/listing 上） */
async function createCommunityWatch(
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
        object_type: "community",
        object_id: "cmt_TEST-shared",
        display_name_snapshot: "TEST-共享小区",
      }),
    },
    env,
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { item: { watch_id: string } };
  return body.item.watch_id;
}

/** TASK-03B：合法的目标单价规则 payload（community_unit_price_lte 主绑定） */
function validCommunityRule(): Record<string, unknown> {
  return {
    rule_type: "community_unit_price_lte",
    metric_code: "community_ask_median_unit",
    price_type: "listing_ask",
    target_value: 20000,
    unit: "元/㎡",
  };
}

/** POST /me/watch-items/:id/rules（原样返回 Response，供状态码断言） */
async function postRule(
  token: string,
  watchId: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return await app.request(
    `/api/v1/me/watch-items/${watchId}/rules`,
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(payload),
    },
    ctx.env,
  );
}

/** PATCH /me/rules/:id（原样返回 Response，供状态码断言） */
async function patchRule(
  token: string,
  ruleId: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return await app.request(
    `/api/v1/me/rules/${ruleId}`,
    {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify(payload),
    },
    ctx.env,
  );
}

/** 解析错误信封 { error_code, details }，返回全部 message */
async function errorMessages(res: Response): Promise<string[]> {
  const parsed = (await res.json()) as {
    error_code: string;
    details?: Array<{ message: string }>;
  };
  expect(parsed.error_code).toBe("validation_failed");
  return (parsed.details ?? []).map((d) => d.message);
}

// ---------------- TASK-03A：测试辅助（item 响应/POST/PATCH/GET 列表） ----------------

/** watch-items item 响应结构（03A：group_name/auto_monitoring；03B：规则摘要） */
interface WatchItemJson {
  watch_id: string;
  object_type: string;
  object_id: string;
  display_name_snapshot: string;
  priority: number;
  status: string;
  group_name: string | null;
  auto_monitoring: boolean;
  enabled_rule_count: number;
  rule_highlight: {
    rule_id: string;
    rule_type: string;
    metric_code: string;
    price_type: string | null;
    target_value: number | null;
    unit: string | null;
    threshold_pct: number | null;
  } | null;
  created_at: string;
  updated_at: string;
}

/** POST /me/watch-items（原样返回 Response，供状态码断言） */
async function postItem(
  token: string,
  payload: Record<string, unknown>,
): Promise<Response> {
  return await app.request(
    "/api/v1/me/watch-items",
    {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify(payload),
    },
    ctx.env,
  );
}

/** PATCH /me/watch-items/:id（原样返回 Response） */
async function patchItem(
  token: string,
  watchId: string,
  patch: Record<string, unknown>,
): Promise<Response> {
  return await app.request(
    `/api/v1/me/watch-items/${watchId}`,
    {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify(patch),
    },
    ctx.env,
  );
}

/** GET /me/watch-items（qs 为已编码的查询串，断言 200 后返回列表体） */
async function listWatch(
  token: string,
  qs = "",
): Promise<{ items: WatchItemJson[]; count: number }> {
  const res = await app.request(
    `/api/v1/me/watch-items${qs}`,
    { headers: jsonHeaders(token) },
    ctx.env,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { items: WatchItemJson[]; count: number };
}

beforeEach(async () => {
  ctx = createTestEnv();
  await seedUser(ctx.priv, "usr_a", "demo.a@example.com", TOK_A);
  await seedUser(ctx.priv, "usr_b", "demo.b@example.com", TOK_B);
  // TASK-03A：目录种子——POST 对 region/community 做 Public 库存在性校验
  for (const token of [TOK_A, TOK_B]) {
    ctx.pub
      .prepare(
        "INSERT INTO cities (city_code, name, province_code) VALUES (?, ?, '110000')",
      )
      .run(`city_${token}`, `测试市-${token}`);
    ctx.pub
      .prepare(
        "INSERT INTO regions (region_id, city_code, name, level) VALUES (?, ?, ?, 'district')",
      )
      .run(`rgn_${token}`, `city_${token}`, `测试区-${token}`);
  }
  ctx.pub
    .prepare(
      "INSERT INTO communities (community_id, city_code, name) VALUES ('cmt_TEST-shared', ?, 'TEST-共享小区')",
    )
    .run(`city_${TOK_A}`);
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
    const watchId = await createCommunityWatch(app, ctx.env, TOK_A);
    const aRule = await postRule(TOK_A, watchId, validCommunityRule());
    expect(aRule.status).toBe(201);
    const ruleId = ((await aRule.json()) as { item: { rule_id: string } }).item
      .rule_id;

    // B 挂规则：loadOwnWatch 先于 schema 校验 → 跨用户一律 404
    const bRule = await postRule(TOK_B, watchId, validCommunityRule());
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

describe("TASK-05A 事件接口扩展（type 过滤 / unread_count / evidence / 标记未读）", () => {
  beforeEach(() => {
    ctx.priv
      .prepare(
        `INSERT INTO alert_events
           (event_id, user_id, event_key, event_type, old_value, new_value, target_value,
            difference_pct, evidence_json, snapshot_id, status)
         VALUES
           ('evt_t', 'usr_a', 'key-t', 'target_price_reached', 32000, 29500, 30000, -7.81,
            '{"explanation":"已达到目标价 30000 元/㎡","rule_version":2,"evidence_lines":["统计日期 2026-11-11"]}',
            'snap_x', 'unread'),
           ('evt_d', 'usr_a', 'key-d', 'update_delayed', NULL, NULL, NULL, NULL,
            '{"explanation":"最新数据滞后 30 天","sla_days":10}',
            NULL, 'unread')`,
      )
      .run();
  });

  it("type 过滤命中四类枚举，非法 type 400", async () => {
    const filtered = await app.request(
      "/api/v1/me/events?type=target_price_reached",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as {
      count: number;
      items: Array<Record<string, unknown>>;
      unread_count: number;
    };
    expect(body.count).toBe(1);
    expect(body.items[0]!.event_type).toBe("target_price_reached");
    expect(body.unread_count).toBe(2); // 未读总数不受 type/limit 影响

    const bad = await app.request(
      "/api/v1/me/events?type=bogus_type",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error_code?: string }).error_code).toBe(
      "validation_failed",
    );
  });

  it("evidence 全字段返回（evidence_json 解析为对象）", async () => {
    const res = await app.request(
      "/api/v1/me/events?limit=50",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      unread_count: number;
    };
    expect(body.items).toHaveLength(2);
    const t = body.items.find((i) => i.event_id === "evt_t");
    expect(t?.snapshot_id).toBe("snap_x");
    expect(t?.difference_pct).toBe(-7.81);
    const ev = t?.evidence as Record<string, unknown>;
    expect(ev.rule_version).toBe(2);
    expect(ev.explanation).toContain("目标价");
    expect(Array.isArray(ev.evidence_lines)).toBe(true);
  });

  it("PATCH {read:false} 标记未读，与 {read:true}/{} 已读均幂等", async () => {
    const read = await app.request(
      "/api/v1/me/events/evt_t/read",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(read.status).toBe(200);
    const afterRead = await app.request(
      "/api/v1/me/events",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(
      ((await afterRead.json()) as { unread_count: number }).unread_count,
    ).toBe(1);

    const unread = await app.request(
      "/api/v1/me/events/evt_t/read",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({ read: false }),
      },
      ctx.env,
    );
    expect(unread.status).toBe(200);
    expect(
      (
        (await unread.json()) as {
          event: { status: string; read_at: string | null };
        }
      ).event,
    ).toMatchObject({ status: "unread", read_at: null });
    const afterUnread = await app.request(
      "/api/v1/me/events",
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(
      ((await afterUnread.json()) as { unread_count: number }).unread_count,
    ).toBe(2);

    // 额外字段仍 400
    const bad = await app.request(
      "/api/v1/me/events/evt_t/read",
      {
        method: "PATCH",
        headers: jsonHeaders(TOK_A),
        body: JSON.stringify({ read: true, user_id: "usr_b" }),
      },
      ctx.env,
    );
    expect(bad.status).toBe(400);
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

// ---------------- TASK-03A：监控对象管理（筛选排序 / 分组 / 目录校验 / 级联） ----------------

describe("暂停/恢复与 status 筛选", () => {
  it("PATCH status paused→active 往返，status 筛选命中正确", async () => {
    const w1 = await createWatch(app, ctx.env, TOK_A);
    const second = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_B}`,
      display_name_snapshot: "测试区域-B",
    });
    expect(second.status).toBe(201);
    const w2 = ((await second.json()) as { item: WatchItemJson }).item.watch_id;

    // 暂停第二个对象
    const pause = await patchItem(TOK_A, w2, { status: "paused" });
    expect(pause.status).toBe(200);
    expect(((await pause.json()) as { item: WatchItemJson }).item.status).toBe(
      "paused",
    );

    // 筛选命中/不命中正确
    const paused = await listWatch(TOK_A, "?status=paused");
    expect(paused.items.map((i) => i.watch_id)).toEqual([w2]);
    const active = await listWatch(TOK_A, "?status=active");
    expect(active.items.map((i) => i.watch_id)).toEqual([w1]);
    expect((await listWatch(TOK_A, "?status=all")).count).toBe(2);

    // 恢复 → 往返 active
    const resume = await patchItem(TOK_A, w2, { status: "active" });
    expect(resume.status).toBe(200);
    expect(((await resume.json()) as { item: WatchItemJson }).item.status).toBe(
      "active",
    );
    expect((await listWatch(TOK_A, "?status=paused")).count).toBe(0);
    expect((await listWatch(TOK_A, "?status=active")).count).toBe(2);
  });

  it("非法 status/object_type/sort/order/group_name 查询参数 → 400 validation_failed", async () => {
    const cases: Array<[string, string]> = [
      ["status", "?status=bogus"],
      ["object_type", "?object_type=planet"],
      ["sort", "?sort=created"],
      ["order", "?order=up"],
      ["group_name", `?group_name=${encodeURIComponent("x".repeat(51))}`],
    ];
    for (const [field, qs] of cases) {
      const res = await app.request(
        `/api/v1/me/watch-items${qs}`,
        { headers: jsonHeaders(TOK_A) },
        ctx.env,
      );
      expect(res.status, qs).toBe(400);
      const body = (await res.json()) as {
        error_code: string;
        details?: Array<{ field: string }>;
      };
      expect(body.error_code).toBe("validation_failed");
      expect(body.details?.[0]?.field).toBe(field);
    }
  });
});

describe("排序 sort/order", () => {
  it("sort=priority 按优先级升降，sort=created_at 按创建时间升降", async () => {
    // 两个对象 + 独立优先级与创建时间（避免 datetime('now') 同秒并列）
    const a = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_A}`,
      display_name_snapshot: "对象A",
    });
    const b = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_B}`,
      display_name_snapshot: "对象B",
    });
    const itemA = ((await a.json()) as { item: WatchItemJson }).item;
    const itemB = ((await b.json()) as { item: WatchItemJson }).item;
    expect(
      (await patchItem(TOK_A, itemA.watch_id, { priority: 10 })).status,
    ).toBe(200);
    expect(
      (await patchItem(TOK_A, itemB.watch_id, { priority: -5 })).status,
    ).toBe(200);
    ctx.priv
      .prepare("UPDATE watch_items SET created_at = ? WHERE watch_id = ?")
      .run("2026-01-01 00:00:00", itemA.watch_id);
    ctx.priv
      .prepare("UPDATE watch_items SET created_at = ? WHERE watch_id = ?")
      .run("2026-01-02 00:00:00", itemB.watch_id);

    const pDesc = await listWatch(TOK_A, "?sort=priority&order=desc");
    expect(pDesc.items.map((i) => i.priority)).toEqual([10, -5]);
    const pAsc = await listWatch(TOK_A, "?sort=priority&order=asc");
    expect(pAsc.items.map((i) => i.priority)).toEqual([-5, 10]);

    const cAsc = await listWatch(TOK_A, "?sort=created_at&order=asc");
    expect(cAsc.items.map((i) => i.watch_id)).toEqual([
      itemA.watch_id,
      itemB.watch_id,
    ]);
    // 缺省 sort=created_at&order=desc
    const cDefault = await listWatch(TOK_A);
    expect(cDefault.items.map((i) => i.watch_id)).toEqual([
      itemB.watch_id,
      itemA.watch_id,
    ]);
  });
});

describe("分组管理（group_name）", () => {
  it("创建入组、PATCH 改组、null 移出，筛选生效且改名后旧组不命中", async () => {
    const first = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_A}`,
      display_name_snapshot: "分组对象",
      group_name: "自选组",
    });
    expect(first.status).toBe(201);
    const w1 = ((await first.json()) as { item: WatchItemJson }).item;
    expect(w1.group_name).toBe("自选组");

    // 未分组对象 group_name 为 null，且不落入筛选
    const plain = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_B}`,
      display_name_snapshot: "未分组对象",
    });
    const plainItem = ((await plain.json()) as { item: WatchItemJson }).item;
    expect(plainItem.group_name).toBeNull();

    const inGroup = await listWatch(
      TOK_A,
      `?group_name=${encodeURIComponent("自选组")}`,
    );
    expect(inGroup.items.map((i) => i.watch_id)).toEqual([w1.watch_id]);

    // 改组（upsert）：旧组不命中，新组命中
    const renamed = await patchItem(TOK_A, w1.watch_id, {
      group_name: "新组",
    });
    expect(renamed.status).toBe(200);
    expect(
      ((await renamed.json()) as { item: WatchItemJson }).item.group_name,
    ).toBe("新组");
    expect(
      (await listWatch(TOK_A, `?group_name=${encodeURIComponent("自选组")}`))
        .count,
    ).toBe(0);
    const newGroup = await listWatch(
      TOK_A,
      `?group_name=${encodeURIComponent("新组")}`,
    );
    expect(newGroup.items.map((i) => i.watch_id)).toEqual([w1.watch_id]);

    // null = 移出分组
    const removed = await patchItem(TOK_A, w1.watch_id, { group_name: null });
    expect(removed.status).toBe(200);
    expect(
      ((await removed.json()) as { item: WatchItemJson }).item.group_name,
    ).toBeNull();
    expect(
      (await listWatch(TOK_A, `?group_name=${encodeURIComponent("新组")}`))
        .count,
    ).toBe(0);
    // 移出后私有库分组行被删除
    const rows = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM watch_item_groups")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("分组筛选不泄漏他人数据：B 按 A 的组名筛选为空，同名组只见自己的", async () => {
    await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_A}`,
      display_name_snapshot: "A 的分组对象",
      group_name: "团队组",
    });
    const bEmpty = await listWatch(
      TOK_B,
      `?group_name=${encodeURIComponent("团队组")}`,
    );
    expect(bEmpty.count).toBe(0);

    await postItem(TOK_B, {
      object_type: "region",
      object_id: `rgn_${TOK_B}`,
      display_name_snapshot: "B 的分组对象",
      group_name: "团队组",
    });
    const bOwn = await listWatch(
      TOK_B,
      `?group_name=${encodeURIComponent("团队组")}`,
    );
    expect(bOwn.items.map((i) => i.object_id)).toEqual([`rgn_${TOK_B}`]);
    // A 侧同样只见自己的
    const aOwn = await listWatch(
      TOK_A,
      `?group_name=${encodeURIComponent("团队组")}`,
    );
    expect(aOwn.items.map((i) => i.object_id)).toEqual([`rgn_${TOK_A}`]);
  });

  it("POST/PATCH 分组名超出 1–50 字符 → 400 validation_failed", async () => {
    const long = "x".repeat(51);
    const postRes = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_A}`,
      display_name_snapshot: "超长组名",
      group_name: long,
    });
    expect(postRes.status).toBe(400);
    expect(((await postRes.json()) as { error_code: string }).error_code).toBe(
      "validation_failed",
    );

    const w1 = await createWatch(app, ctx.env, TOK_A);
    const patchRes = await patchItem(TOK_A, w1, { group_name: long });
    expect(patchRes.status).toBe(400);
    const emptyRes = await patchItem(TOK_A, w1, { group_name: "" });
    expect(emptyRes.status).toBe(400);
  });
});

describe("目录校验与去重", () => {
  it("region/community 目录不存在 → 404 not_found（error_code 稳定）", async () => {
    const regionRes = await postItem(TOK_A, {
      object_type: "region",
      object_id: "rgn_TEST-missing",
      display_name_snapshot: "不存在的区域",
    });
    expect(regionRes.status).toBe(404);
    expect(
      ((await regionRes.json()) as { error_code: string }).error_code,
    ).toBe("not_found");

    const communityRes = await postItem(TOK_A, {
      object_type: "community",
      object_id: "cmt_TEST-missing",
      display_name_snapshot: "不存在的小区",
    });
    expect(communityRes.status).toBe(404);
    expect(
      ((await communityRes.json()) as { error_code: string }).error_code,
    ).toBe("not_found");
    // 校验失败不落库
    expect((await listWatch(TOK_A)).count).toBe(0);
  });

  it("listing 不做目录校验可创建，auto_monitoring 恒 false（无挂牌事件）", async () => {
    const res = await postItem(TOK_A, {
      object_type: "listing",
      object_id: "lst_TEST-0001",
      display_name_snapshot: "TEST-房源",
    });
    expect(res.status).toBe(201);
    const item = ((await res.json()) as { item: WatchItemJson }).item;
    expect(item.object_type).toBe("listing");
    expect(item.auto_monitoring).toBe(false);
  });

  it("目录内小区无价格数据 → 创建成功且 auto_monitoring=false（未覆盖对象可收藏）", async () => {
    const res = await postItem(TOK_A, {
      object_type: "community",
      object_id: "cmt_TEST-shared",
      display_name_snapshot: "TEST-共享小区",
      priority: 7,
    });
    expect(res.status).toBe(201);
    const item = ((await res.json()) as { item: WatchItemJson }).item;
    expect(item.auto_monitoring).toBe(false);
    expect(item.priority).toBe(7);
  });

  it("同一用户对同一 community 重复 POST → 409 conflict", async () => {
    const payload = {
      object_type: "community",
      object_id: "cmt_TEST-shared",
      display_name_snapshot: "TEST-共享小区",
    };
    expect((await postItem(TOK_A, payload)).status).toBe(201);
    const dup = await postItem(TOK_A, payload);
    expect(dup.status).toBe(409);
    const text = await dup.text();
    expect(text).toContain('"error_code":"conflict"');
    expect(text).not.toMatch(/UNIQUE|sqlite|INSERT/i);
  });
});

describe("auto_monitoring 读取时批量计算", () => {
  it("有价格快照→true、无→false、listing→false；快照删除后读取即变 false（不落库）", async () => {
    // 种子 TEST- 价格快照：仅覆盖 rgn_TOK_A
    ctx.pub
      .prepare(
        `INSERT INTO price_snapshots
           (snapshot_id, object_type, object_id, price_type, metric_code, median, sample_count, stat_date)
         VALUES ('snap_TEST_a', 'region', ?, 'closed_transaction', 'median_unit_price', 19500, 12, '2026-11-01')`,
      )
      .run(`rgn_${TOK_A}`);

    const covered = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_A}`,
      display_name_snapshot: "有快照的区域",
    });
    expect(
      ((await covered.json()) as { item: WatchItemJson }).item.auto_monitoring,
    ).toBe(true);

    const uncovered = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_B}`,
      display_name_snapshot: "无快照的区域",
    });
    expect(
      ((await uncovered.json()) as { item: WatchItemJson }).item
        .auto_monitoring,
    ).toBe(false);

    const listing = await postItem(TOK_A, {
      object_type: "listing",
      object_id: "lst_TEST-0002",
      display_name_snapshot: "TEST-房源2",
    });
    expect(
      ((await listing.json()) as { item: WatchItemJson }).item.auto_monitoring,
    ).toBe(false);

    // GET 批量计算结果一致
    const list = await listWatch(TOK_A);
    const byId = new Map(list.items.map((i) => [i.object_id, i]));
    expect(byId.get(`rgn_${TOK_A}`)?.auto_monitoring).toBe(true);
    expect(byId.get(`rgn_${TOK_B}`)?.auto_monitoring).toBe(false);
    expect(byId.get("lst_TEST-0002")?.auto_monitoring).toBe(false);

    // 快照删除 → 下次读取即为 false（计算不落库）
    ctx.pub
      .prepare("DELETE FROM price_snapshots WHERE snapshot_id = 'snap_TEST_a'")
      .run();
    const after = await listWatch(TOK_A);
    const afterById = new Map(after.items.map((i) => [i.object_id, i]));
    expect(afterById.get(`rgn_${TOK_A}`)?.auto_monitoring).toBe(false);
  });
});

describe("删除级联", () => {
  it("删除带规则与分组的对象后 watch_rules/watch_item_groups/watch_rule_settings 全部消失", async () => {
    const created = await postItem(TOK_A, {
      object_type: "community",
      object_id: "cmt_TEST-shared",
      display_name_snapshot: "带规则与分组",
      group_name: "待删除组",
    });
    const item = ((await created.json()) as { item: WatchItemJson }).item;
    const ruleRes = await postRule(TOK_A, item.watch_id, {
      ...validCommunityRule(),
      valid_until: "2027-06-30",
      notify_digest: false,
    });
    expect(ruleRes.status).toBe(201);
    const ruleId = ((await ruleRes.json()) as { item: { rule_id: string } })
      .item.rule_id;

    const countRows = (table: string): number => {
      const row = ctx.priv
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE watch_id = ?`)
        .get(item.watch_id) as { n: number };
      return row.n;
    };
    expect(countRows("watch_rules")).toBe(1);
    expect(countRows("watch_item_groups")).toBe(1);
    expect(
      ctx.priv
        .prepare(
          "SELECT COUNT(*) AS n FROM watch_rule_settings WHERE rule_id = ?",
        )
        .get(ruleId),
    ).toEqual({ n: 1 });

    const del = await app.request(
      `/api/v1/me/watch-items/${item.watch_id}`,
      { method: "DELETE", headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    expect(countRows("watch_rules")).toBe(0);
    expect(countRows("watch_item_groups")).toBe(0);
    // 设置行随 FK 级联消失（无孤儿）
    expect(
      ctx.priv
        .prepare(
          "SELECT COUNT(*) AS n FROM watch_rule_settings WHERE rule_id = ?",
        )
        .get(ruleId),
    ).toEqual({ n: 0 });
    expect((await listWatch(TOK_A)).count).toBe(0);
  });
});

describe("多对象混合交叉用例", () => {
  it("混合类型增删改 + 类型/分组/排序筛选 + 跨用户 404 组合", async () => {
    const region = await postItem(TOK_A, {
      object_type: "region",
      object_id: `rgn_${TOK_A}`,
      display_name_snapshot: "区域对象",
      group_name: "组一",
    });
    const community = await postItem(TOK_A, {
      object_type: "community",
      object_id: "cmt_TEST-shared",
      display_name_snapshot: "小区对象",
      group_name: "组二",
    });
    const listing = await postItem(TOK_A, {
      object_type: "listing",
      object_id: "lst_TEST-0003",
      display_name_snapshot: "房源对象",
    });
    const regionItem = ((await region.json()) as { item: WatchItemJson }).item;
    const communityItem = (
      (await community.json()) as {
        item: WatchItemJson;
      }
    ).item;
    const listingItem = ((await listing.json()) as { item: WatchItemJson })
      .item;
    expect(
      (await patchItem(TOK_A, regionItem.watch_id, { priority: 3 })).status,
    ).toBe(200);
    expect(
      (await patchItem(TOK_A, communityItem.watch_id, { priority: 9 })).status,
    ).toBe(200);
    expect(
      (await patchItem(TOK_A, listingItem.watch_id, { priority: -1 })).status,
    ).toBe(200);

    // B 也入同名组（组一），验证互不泄漏
    await postItem(TOK_B, {
      object_type: "region",
      object_id: `rgn_${TOK_B}`,
      display_name_snapshot: "B 的区域",
      group_name: "组一",
    });

    // 类型筛选
    const communities = await listWatch(TOK_A, "?object_type=community");
    expect(communities.items.map((i) => i.object_id)).toEqual([
      "cmt_TEST-shared",
    ]);
    const listings = await listWatch(TOK_A, "?object_type=listing");
    expect(listings.count).toBe(1);

    // 分组 + 排序组合（A 的组一只有一个对象）
    const g1 = await listWatch(
      TOK_A,
      `?group_name=${encodeURIComponent("组一")}&sort=priority&order=desc`,
    );
    expect(g1.items.map((i) => i.watch_id)).toEqual([regionItem.watch_id]);

    // 全量按优先级降序
    const all = await listWatch(TOK_A, "?sort=priority&order=desc");
    expect(all.items.map((i) => i.priority)).toEqual([9, 3, -1]);

    // B 的组一筛选只见 B 自己
    const bGroup = await listWatch(
      TOK_B,
      `?group_name=${encodeURIComponent("组一")}`,
    );
    expect(bGroup.items.map((i) => i.object_id)).toEqual([`rgn_${TOK_B}`]);

    // 跨用户 PATCH/DELETE → 404
    expect(
      (await patchItem(TOK_B, regionItem.watch_id, { status: "paused" }))
        .status,
    ).toBe(404);
    const bDel = await app.request(
      `/api/v1/me/watch-items/${regionItem.watch_id}`,
      { method: "DELETE", headers: jsonHeaders(TOK_B) },
      ctx.env,
    );
    expect(bDel.status).toBe(404);

    // A 删除小区对象后其余对象与筛选不受影响
    const del = await app.request(
      `/api/v1/me/watch-items/${communityItem.watch_id}`,
      { method: "DELETE", headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(del.status).toBe(200);
    expect((await listWatch(TOK_A, "?object_type=community")).count).toBe(0);
    expect((await listWatch(TOK_A)).count).toBe(2);
    // B 的对象不受 A 删除影响
    expect((await listWatch(TOK_B)).count).toBe(1);
  });
});

// ============================ TASK-03B：规则编辑器 ============================

describe("TASK-03B 规则绑定校验（验收场景）", () => {
  it("验收 1：listing 对象不能挂小区单价规则 / community 不能挂房源总价规则", async () => {
    // listing watch item（API 不做 listing 目录校验，03A 约定）
    const lst = await postItem(TOK_A, {
      object_type: "listing",
      object_id: "lst_TEST-0001",
      display_name_snapshot: "TEST-房源",
    });
    expect(lst.status).toBe(201);
    const lstItem = ((await lst.json()) as { item: WatchItemJson }).item;

    const cross1 = await postRule(TOK_A, lstItem.watch_id, {
      rule_type: "community_unit_price_lte",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      target_value: 20000,
      unit: "元/㎡",
    });
    expect(cross1.status).toBe(400);
    expect((await errorMessages(cross1))[0]).toContain("仅适用于 community");

    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const cross2 = await postRule(TOK_A, cmt, {
      rule_type: "listing_total_price_lte",
      metric_code: "listing_ask_total",
      price_type: "listing_ask",
      target_value: 3000000,
      unit: "元",
    });
    expect(cross2.status).toBe(400);

    // listing 对象 + 小区中位价指标（价格_drop 场景）→ 专属文案
    const cross3 = await postRule(TOK_A, lstItem.watch_id, {
      rule_type: "price_drop_pct",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      unit: "元/㎡",
      threshold_pct: 5,
      window_days: 30,
    });
    expect(cross3.status).toBe(400);
    expect((await errorMessages(cross3))[0]).toContain(
      "不能把小区挂牌中位价与具体房源比较",
    );
  });

  it("验收 2：官方指数不能作为元/㎡目标价", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const res = await postRule(TOK_A, cmt, {
      rule_type: "community_unit_price_lte",
      metric_code: "official_price_index",
      price_type: "official_index",
      target_value: 100,
      unit: "元/㎡",
    });
    expect(res.status).toBe(400);
    expect((await errorMessages(res))[0]).toContain(
      "官方指数不能作为元/㎡目标价",
    );
  });

  it("单位与指标口径必须一致；缺 price_type 拒绝；未知 rule_type 拒绝", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const badUnit = await postRule(TOK_A, cmt, {
      rule_type: "community_unit_price_lte",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      target_value: 20000,
      unit: "元", // 总价单位错配
    });
    expect(badUnit.status).toBe(400);
    expect((await errorMessages(badUnit))[0]).toContain("单位必须是「元/㎡」");

    const noPriceType = await postRule(TOK_A, cmt, {
      rule_type: "community_unit_price_lte",
      metric_code: "community_ask_median_unit",
      target_value: 20000,
      unit: "元/㎡",
    });
    expect(noPriceType.status).toBe(400);

    const unknownType = await postRule(TOK_A, cmt, {
      rule_type: "price_below",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      target_value: 20000,
      unit: "元/㎡",
    });
    expect(unknownType.status).toBe(400);
  });

  it("字段策略：lte 缺目标价 400、跌幅带 target_value 400、region 对象 400", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const missingTarget = await postRule(TOK_A, cmt, {
      rule_type: "community_unit_price_lte",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      unit: "元/㎡",
    });
    expect(missingTarget.status).toBe(400);
    expect((await errorMessages(missingTarget))[0]).toContain(
      "缺少必需字段 target_value",
    );

    const dropWithTarget = await postRule(TOK_A, cmt, {
      rule_type: "price_drop_pct",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      unit: "元/㎡",
      threshold_pct: 5,
      window_days: 30,
      target_value: 20000,
    });
    expect(dropWithTarget.status).toBe(400);

    // 合法跌幅规则通过
    const dropOk = await postRule(TOK_A, cmt, {
      rule_type: "price_drop_pct",
      metric_code: "community_ask_median_unit",
      price_type: "listing_ask",
      unit: "元/㎡",
      threshold_pct: 5,
      window_days: 30,
    });
    expect(dropOk.status).toBe(201);

    const regionWatch = await createWatch(app, ctx.env, TOK_A);
    const regionRule = await postRule(TOK_A, regionWatch, validCommunityRule());
    expect(regionRule.status).toBe(400);
    expect((await errorMessages(regionRule))[0]).toContain("区域对象暂不支持");
  });
});

describe("TASK-03B 有效期与通知渠道", () => {
  it("valid_until/渠道往返，is_expired 两态，非法日期 400", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const created = await postRule(TOK_A, cmt, {
      ...validCommunityRule(),
      valid_until: "2099-12-31",
      notify_email: true,
      notify_digest: false,
      notify_inapp: true,
    });
    expect(created.status).toBe(201);
    const item = (await created.json()) as { item: Record<string, unknown> };
    expect(item.item.valid_until).toBe("2099-12-31");
    expect(item.item.notify_email).toBe(true);
    expect(item.item.notify_digest).toBe(false);
    expect(item.item.notify_inapp).toBe(true);
    expect(item.item.is_expired).toBe(false);

    // GET 列表一致
    const listRes = await app.request(
      `/api/v1/me/watch-items/${cmt}/rules`,
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items[0]!.valid_until).toBe("2099-12-31");
    expect(list.items[0]!.is_expired).toBe(false);

    const ruleId = item.item.rule_id as string;
    // 过去日期 → is_expired=true
    const past = await patchRule(TOK_A, ruleId, { valid_until: "2020-01-01" });
    expect(past.status).toBe(200);
    expect(
      ((await past.json()) as { item: { is_expired: boolean } }).item
        .is_expired,
    ).toBe(true);
    // 清除有效期 → 长期有效
    const cleared = await patchRule(TOK_A, ruleId, { valid_until: null });
    expect(cleared.status).toBe(200);
    const clearedItem = (await cleared.json()) as {
      item: { valid_until: string | null; is_expired: boolean };
    };
    expect(clearedItem.item.valid_until).toBeNull();
    expect(clearedItem.item.is_expired).toBe(false);
    // 非法日期格式 → schema 400
    const badDate = await patchRule(TOK_A, ruleId, {
      valid_until: "2027/06/30",
    });
    expect(badDate.status).toBe(400);
  });

  it("渠道至少保留一个；POST 显式全关也拒绝", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const created = await postRule(TOK_A, cmt, validCommunityRule());
    expect(created.status).toBe(201);
    const ruleId = ((await created.json()) as { item: { rule_id: string } })
      .item.rule_id;

    const allOff = await patchRule(TOK_A, ruleId, {
      notify_email: false,
      notify_digest: false,
      notify_inapp: false,
    });
    expect(allOff.status).toBe(400);
    expect((await errorMessages(allOff))[0]).toContain("至少保留一个通知渠道");

    const postAllOff = await postRule(TOK_A, cmt, {
      ...validCommunityRule(),
      notify_email: false,
      notify_digest: false,
      notify_inapp: false,
    });
    expect(postAllOff.status).toBe(400);

    // 关掉一个渠道再补开另一个：先只关 email（仍剩两个）→ 200
    const oneOff = await patchRule(TOK_A, ruleId, { notify_email: false });
    expect(oneOff.status).toBe(200);
    const afterOne = (await oneOff.json()) as {
      item: { notify_email: boolean };
    };
    expect(afterOne.item.notify_email).toBe(false);
  });

  it("缺 settings 行的旧规则按渠道全开、无有效期返回", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const created = await postRule(TOK_A, cmt, validCommunityRule());
    const ruleId = ((await created.json()) as { item: { rule_id: string } })
      .item.rule_id;
    // 模拟 03B 之前的规则：直接删掉 settings 行
    ctx.priv
      .prepare("DELETE FROM watch_rule_settings WHERE rule_id = ?")
      .run(ruleId);
    const listRes = await app.request(
      `/api/v1/me/watch-items/${cmt}/rules`,
      { headers: jsonHeaders(TOK_A) },
      ctx.env,
    );
    const list = (await listRes.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(list.items[0]!.notify_email).toBe(true);
    expect(list.items[0]!.notify_digest).toBe(true);
    expect(list.items[0]!.notify_inapp).toBe(true);
    expect(list.items[0]!.valid_until).toBeNull();
    expect(list.items[0]!.is_expired).toBe(false);
    // 对旧规则做渠道 PATCH → 侧表行被补建（upsert）
    const patched = await patchRule(TOK_A, ruleId, {
      valid_until: "2030-01-01",
    });
    expect(patched.status).toBe(200);
    expect(
      ctx.priv
        .prepare(
          "SELECT COUNT(*) AS n FROM watch_rule_settings WHERE rule_id = ?",
        )
        .get(ruleId),
    ).toEqual({ n: 1 });
  });
});

describe("TASK-03B 触发状态、re-arm 与版本", () => {
  it("启用即重新布防 armed_state，启停不递增 version，改目标价 version+1", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const created = await postRule(TOK_A, cmt, validCommunityRule());
    const item0 = (await created.json()) as {
      item: { rule_id: string; version: number; armed_state: string };
    };
    const ruleId = item0.item.rule_id;
    expect(item0.item.version).toBe(1);
    expect(item0.item.armed_state).toBe("armed");

    // 模拟 03C 触发后的状态
    ctx.priv
      .prepare(
        "UPDATE watch_rules SET armed_state = 'triggered' WHERE rule_id = ?",
      )
      .run(ruleId);

    // 停用 → armed_state 不变、version 不变
    const off = await patchRule(TOK_A, ruleId, { is_enabled: false });
    expect(off.status).toBe(200);
    const offItem = (await off.json()) as {
      item: { armed_state: string; version: number; is_enabled: number };
    };
    expect(offItem.item.armed_state).toBe("triggered");
    expect(offItem.item.version).toBe(1);
    expect(offItem.item.is_enabled).toBe(0);

    // 再启用 → armed_state 回到 armed（重新布防），version 仍不变
    const on = await patchRule(TOK_A, ruleId, { is_enabled: true });
    const onItem = (await on.json()) as {
      item: { armed_state: string; version: number; is_enabled: number };
    };
    expect(onItem.item.armed_state).toBe("armed");
    expect(onItem.item.version).toBe(1);
    expect(onItem.item.is_enabled).toBe(1);

    // 改目标价 → version+1
    const bump = await patchRule(TOK_A, ruleId, { target_value: 19500 });
    const bumpItem = (await bump.json()) as {
      item: { version: number; target_value: number };
    };
    expect(bumpItem.item.version).toBe(2);
    expect(bumpItem.item.target_value).toBe(19500);

    // 改有效期/渠道 → version 不变
    const settings = await patchRule(TOK_A, ruleId, {
      valid_until: "2031-01-01",
      notify_inapp: false,
    });
    const settingsItem = (await settings.json()) as {
      item: { version: number };
    };
    expect(settingsItem.item.version).toBe(2);

    // 相同目标价再次提交 → 内容无变化，version 不变
    const noop = await patchRule(TOK_A, ruleId, { target_value: 19500 });
    expect(
      ((await noop.json()) as { item: { version: number } }).item.version,
    ).toBe(2);

    // armed_state 不接受客户端直写（schema additionalProperties=false → 400）
    const direct = await patchRule(TOK_A, ruleId, {
      armed_state: "disarmed",
    } as never);
    expect(direct.status).toBe(400);
    // version 也不可直写
    const directVersion = await patchRule(TOK_A, ruleId, {
      version: 99,
    } as never);
    expect(directVersion.status).toBe(400);
  });
});

describe("TASK-03B watch 卡片规则摘要", () => {
  it("enabled_rule_count/rule_highlight 批量聚合正确（含无规则与全停用）", async () => {
    const cmt = await createCommunityWatch(app, ctx.env, TOK_A);
    const regionWatch = await createWatch(app, ctx.env, TOK_A);

    // 无规则：0 / null；region 同样 0 / null（不可能有规则）
    let items = (await listWatch(TOK_A)).items;
    let byId = new Map(items.map((i) => [i.watch_id, i]));
    expect(byId.get(cmt)!.enabled_rule_count).toBe(0);
    expect(byId.get(cmt)!.rule_highlight).toBeNull();
    expect(byId.get(regionWatch)!.enabled_rule_count).toBe(0);

    // 建 1 条启用规则
    const r1 = await postRule(TOK_A, cmt, validCommunityRule());
    const r1Id = ((await r1.json()) as { item: { rule_id: string } }).item
      .rule_id;
    items = (await listWatch(TOK_A)).items;
    byId = new Map(items.map((i) => [i.watch_id, i]));
    expect(byId.get(cmt)!.enabled_rule_count).toBe(1);
    const hl = byId.get(cmt)!.rule_highlight as {
      rule_id: string;
      target_value: number;
      unit: string;
    };
    expect(hl.rule_id).toBe(r1Id);
    expect(hl.target_value).toBe(20000);
    expect(hl.unit).toBe("元/㎡");

    // 再建 1 条停用规则 → count 仍 1，高亮仍指向启用那条
    const r2 = await postRule(TOK_A, cmt, {
      ...validCommunityRule(),
      is_enabled: false,
      target_value: 18000,
    });
    expect(r2.status).toBe(201);
    items = (await listWatch(TOK_A)).items;
    byId = new Map(items.map((i) => [i.watch_id, i]));
    expect(byId.get(cmt)!.enabled_rule_count).toBe(1);
    expect(
      (byId.get(cmt)!.rule_highlight as { target_value: number }).target_value,
    ).toBe(20000);

    // 唯一启用规则停用 → 0 / null
    await patchRule(TOK_A, r1Id, { is_enabled: false });
    items = (await listWatch(TOK_A)).items;
    byId = new Map(items.map((i) => [i.watch_id, i]));
    expect(byId.get(cmt)!.enabled_rule_count).toBe(0);
    expect(byId.get(cmt)!.rule_highlight).toBeNull();

    // PATCH watch item 响应同样携带摘要（前端卡片重渲染依赖）
    const patched = await patchItem(TOK_A, cmt, { priority: 9 });
    const body = (await patched.json()) as {
      item: { enabled_rule_count: number; rule_highlight: unknown };
    };
    expect(body.item.enabled_rule_count).toBe(0);
    expect(body.item.rule_highlight).toBeNull();
  });
});
