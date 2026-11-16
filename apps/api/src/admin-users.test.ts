// TASK-06B：系统总览和用户管理验收（PRD 任务行 1354–1360 / §8.2 / §8.3 / §10.5）
// 覆盖：4 端点门禁矩阵、overview 聚合零 PII、users 列表脱敏与筛选分页、
//       冻结/解冻（禁自冻结/同态 409/404/reason 校验/审计）、冻结后 /me/* 401、
//       monitoring 强制 reason + 审计 + 明细含目标价。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { generate } from "./totp";
import {
  authCookie,
  createTestEnv,
  seedUser,
  type TestContext,
} from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const TOK_ADMIN = "tok-admin-06b";
const TOK_USER = "tok-user-06b";
const TOK_TARGET = "tok-target-06b";
const ADMIN = "usr-admin-06b";
const USER = "usr-plain-06b";
const TARGET = "usr-target-06b";
const DELETED = "usr-deleted-06b";
const TARGET_EMAIL = "target-06b@example.com";

const FREEZE_REASON = "测试冻结理由充足"; // 8+ 字符
const VIEW_REASON = "排查该用户价格提醒投诉工单"; // 10+ 字符

beforeEach(async () => {
  ctx = createTestEnv();
  app = createApp();
  await seedUser(ctx.priv, ADMIN, "admin-06b@example.com", TOK_ADMIN);
  await seedUser(ctx.priv, USER, "user-06b@example.com", TOK_USER);
  await seedUser(ctx.priv, TARGET, TARGET_EMAIL, TOK_TARGET);
  ctx.priv
    .prepare(
      "INSERT INTO admin_roles (admin_id, user_id, role, mfa_required, created_by) VALUES (?, ?, 'admin', 1, 'test')",
    )
    .run(`adm_${ADMIN}`, ADMIN);
  // TARGET 的监控与规则（个人明细端点数据源）
  ctx.priv
    .prepare(
      `INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot)
       VALUES ('w_06b', ?, 'community', 'cmt_06b', '测试小区（虚构）')`,
    )
    .run(TARGET);
  ctx.priv
    .prepare(
      `INSERT INTO watch_rules (rule_id, watch_id, user_id, rule_type, metric_code, price_type, target_value, unit)
       VALUES ('r_06b', 'w_06b', ?, 'community_unit_price_lte', 'community_ask_median_unit', 'listing_ask', 30000, '元/㎡')`,
    )
    .run(TARGET);
  // 注销用户不进列表
  ctx.priv
    .prepare(
      "INSERT INTO users (user_id, email_normalized, status, deleted_at) VALUES (?, 'deleted-06b@example.com', 'active', datetime('now'))",
    )
    .run(DELETED);
});

async function req(
  method: string,
  path: string,
  token?: string,
  payload?: unknown,
): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        ...(payload !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(token ? { Cookie: authCookie(token) } : {}),
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    },
    ctx.env,
  );
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** setup → verify 走真实接口流，完成当前会话 MFA */
async function enableMfa(token: string): Promise<void> {
  const setup = await req("POST", "/api/v1/admin/mfa/setup", token, {});
  expect(setup.status).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  const code = await generate(secret);
  const verified = await req("POST", "/api/v1/admin/mfa/verify", token, {
    code,
  });
  expect(verified.status).toBe(200);
}

function auditRows(action: string): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at")
    .all(action) as unknown as Array<Record<string, unknown>>;
}

const ADMIN_ENDPOINTS = [
  "GET /api/v1/admin/overview",
  "GET /api/v1/admin/users",
  "PATCH /api/v1/admin/users/any/status",
  "GET /api/v1/admin/users/any/monitoring?reason=排查价格提醒投诉工单",
];

// ---------------- 门禁矩阵 ----------------

describe("门禁矩阵（4 端点 × 401/403/403 mfa_required）", () => {
  for (const ep of ADMIN_ENDPOINTS) {
    const [method, path] = ep.split(" ") as [string, string];
    it(`${method} ${path}：未登录 401 / 普通 403 / 未 MFA 403 mfa_required`, async () => {
      const anon = await req(method, path);
      expect(anon.status).toBe(401);

      const plain = await req(method, path, TOK_USER);
      expect(plain.status).toBe(403);
      expect((await body(plain)).error_code).toBe("admin_required");

      const noMfa = await req(method, path, TOK_ADMIN);
      expect(noMfa.status).toBe(403);
      expect((await body(noMfa)).error_code).toBe("mfa_required");
    });
  }
});

// ---------------- GET /admin/overview ----------------

describe("GET /admin/overview（§8.2 聚合，零 PII）", () => {
  it("聚合值精确且响应不含任何个人信息", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req("GET", "/api/v1/admin/overview", TOK_ADMIN);
    expect(res.status).toBe(200);
    const b = await body(res);

    const users = b.users as Record<string, number>;
    expect(users.total).toBe(3); // deleted 排除
    expect(users.active).toBe(3);
    expect(users.frozen).toBe(0);
    expect(users.new_7d).toBe(3);
    expect(users.active_7d).toBe(0); // seedUser 不写 last_login_at

    const monitoring = b.monitoring as Record<string, unknown>;
    expect(monitoring.watches_active).toBe(1);
    expect(monitoring.by_object_type).toEqual({
      region: 0,
      community: 1,
      listing: 0,
    });
    expect(monitoring.rules_enabled).toBe(1);

    const email = (b.email as { last_7d: Record<string, unknown> }).last_7d;
    expect(email).toEqual({
      sent: 0,
      provider_error: 0,
      quota_deferred: 0,
      success_rate: null,
    });

    // 零 PII：无邮箱、无目标价、无用户 ID、无监控内容
    const raw = JSON.stringify(b);
    expect(raw).not.toContain("@");
    expect(raw).not.toContain(ADMIN);
    expect(raw).not.toContain(TARGET);
    expect(raw).not.toContain("30000");
    expect(raw).not.toContain("测试小区");
  });

  it("冻结用户后 users.frozen 计数更新", async () => {
    await enableMfa(TOK_ADMIN);
    const patch = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    expect(patch.status).toBe(200);

    const res = await req("GET", "/api/v1/admin/overview", TOK_ADMIN);
    const users = (await body(res)).users as Record<string, number>;
    expect(users.frozen).toBe(1);
    expect(users.active).toBe(2);
  });
});

// ---------------- GET /admin/users ----------------

describe("GET /admin/users（脱敏列表）", () => {
  it("邮箱脱敏、watch_count/is_admin 正确、注销用户排除、明文邮箱不出现", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req("GET", "/api/v1/admin/users", TOK_ADMIN);
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.total).toBe(3);
    const items = b.items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.user_id)).not.toContain(DELETED);

    const target = items.find((i) => i.user_id === TARGET)!;
    expect(target.email_masked).toBe("ta***@example.com");
    expect(target.status).toBe("active");
    expect(target.watch_count).toBe(1);
    expect(target.is_admin).toBe(false);

    const admin = items.find((i) => i.user_id === ADMIN)!;
    expect(admin.is_admin).toBe(true);
    expect(admin.email_masked).toBe("ad***@example.com");

    const raw = JSON.stringify(b);
    expect(raw).not.toContain(TARGET_EMAIL);
    expect(raw).not.toContain("admin-06b@example.com");
    expect(raw).not.toContain("user-06b@example.com");
  });

  it("q 按 user_id 或完整邮箱精确命中；status 筛选；分页 limit/offset", async () => {
    await enableMfa(TOK_ADMIN);

    const byId = await req("GET", `/api/v1/admin/users?q=${TARGET}`, TOK_ADMIN);
    expect(byId.status).toBe(200);
    expect((await body(byId)).total).toBe(1);

    const byEmail = await req(
      "GET",
      `/api/v1/admin/users?q=${encodeURIComponent(TARGET_EMAIL)}`,
      TOK_ADMIN,
    );
    expect((await body(byEmail)).total).toBe(1);

    const frozen = await req(
      "GET",
      "/api/v1/admin/users?status=frozen",
      TOK_ADMIN,
    );
    expect((await body(frozen)).total).toBe(0);

    const paged = await req(
      "GET",
      "/api/v1/admin/users?limit=1&offset=1",
      TOK_ADMIN,
    );
    const pb = await body(paged);
    expect(pb.total).toBe(3);
    expect((pb.items as unknown[]).length).toBe(1);
    expect(pb.limit).toBe(1);
    expect(pb.offset).toBe(1);
  });

  it("非法 status / 越界 limit → 400 validation_failed", async () => {
    await enableMfa(TOK_ADMIN);
    const badStatus = await req(
      "GET",
      "/api/v1/admin/users?status=hacked",
      TOK_ADMIN,
    );
    expect(badStatus.status).toBe(400);
    expect((await body(badStatus)).error_code).toBe("validation_failed");

    const badLimit = await req(
      "GET",
      "/api/v1/admin/users?limit=abc",
      TOK_ADMIN,
    );
    expect(badLimit.status).toBe(400);
  });
});

// ---------------- PATCH /admin/users/:id/status ----------------

describe("PATCH /admin/users/:id/status（冻结/解冻）", () => {
  it("冻结成功 + 审计落行；解冻恢复；同状态 409；自冻结 409；404", async () => {
    await enableMfa(TOK_ADMIN);

    // 冻结
    const freeze = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    expect(freeze.status).toBe(200);
    const frozenUser = (await freeze.json()) as {
      user: Record<string, unknown>;
    };
    expect(frozenUser.user.status).toBe("frozen");
    expect(frozenUser.user.email_masked).toBe("ta***@example.com");

    const statusAudit = auditRows("admin.user.status");
    expect(statusAudit).toHaveLength(1);
    expect(String(statusAudit[0]!.reason)).toBe(
      `active→frozen｜${FREEZE_REASON}`,
    );
    expect(statusAudit[0]!.resource_id).toBe(TARGET);
    expect(statusAudit[0]!.actor_user_id).toBe(ADMIN);

    // 同状态重复 → 409
    const dup = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    expect(dup.status).toBe(409);

    // 解冻
    const unfreeze = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "active", reason: "申诉通过恢复账号" },
    );
    expect(unfreeze.status).toBe(200);
    expect(
      ((await unfreeze.json()) as { user: { status: string } }).user.status,
    ).toBe("active");
    expect(auditRows("admin.user.status")).toHaveLength(2);

    // 自冻结 → 409（防自锁）
    const self = await req(
      "PATCH",
      `/api/v1/admin/users/${ADMIN}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    expect(self.status).toBe(409);
    expect((await body(self)).message).toContain("不能冻结自己");

    // 目标不存在 → 404
    const missing = await req(
      "PATCH",
      "/api/v1/admin/users/usr_nonexist_06b/status",
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    expect(missing.status).toBe(404);
    expect((await body(missing)).error_code).toBe("not_found");
  });

  it("reason 缺失/过短 → 400；冻结后该用户会话访问 /me/* → 401（验收：阻止登录/新建规则）", async () => {
    await enableMfa(TOK_ADMIN);

    const missing = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen" },
    );
    expect(missing.status).toBe(400);
    expect((await body(missing)).error_code).toBe("validation_failed");

    const short = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: "短" },
    );
    expect(short.status).toBe(400);

    // 冻结前可用
    const before = await req("GET", "/api/v1/me/watch-items", TOK_TARGET);
    expect(before.status).toBe(200);

    const freeze = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    expect(freeze.status).toBe(200);

    // 冻结后：同会话（既有 token）立即 401——含新建规则的 POST 路径同门禁
    const after = await req("GET", "/api/v1/me/watch-items", TOK_TARGET);
    expect(after.status).toBe(401);
    expect((await body(after)).error_code).toBe("unauthorized");

    const createRule = await req(
      "POST",
      "/api/v1/me/watch-items/w_06b/rules",
      TOK_TARGET,
      { rule_type: "community_unit_price_lte" },
    );
    expect(createRule.status).toBe(401);

    // 既有数据保留（拍板 2：不删监控/规则/会话行）
    const watches = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM watch_items WHERE user_id = ?")
      .get(TARGET) as unknown as { n: number };
    const rules = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM watch_rules WHERE user_id = ?")
      .get(TARGET) as unknown as { n: number };
    const sessions = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?")
      .get(TARGET) as unknown as { n: number };
    expect(watches.n).toBe(1);
    expect(rules.n).toBe(1);
    expect(sessions.n).toBe(1);

    // 解冻恢复（无需重新登录）
    const unfreeze = await req(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "active", reason: "申诉通过恢复账号" },
    );
    expect(unfreeze.status).toBe(200);
    const restored = await req("GET", "/api/v1/me/watch-items", TOK_TARGET);
    expect(restored.status).toBe(200);
  });
});

// ---------------- GET /admin/users/:id/monitoring ----------------

describe("GET /admin/users/:id/monitoring（有理由 + 审计）", () => {
  it("reason 缺失/过短 → 400；404 不写审计", async () => {
    await enableMfa(TOK_ADMIN);

    const missing = await req(
      "GET",
      `/api/v1/admin/users/${TARGET}/monitoring`,
      TOK_ADMIN,
    );
    expect(missing.status).toBe(400);
    const err = await body(missing);
    expect(err.error_code).toBe("validation_failed");
    expect(
      (err.details as Array<{ field: string }>).some(
        (d) => d.field === "/reason",
      ),
    ).toBe(true);

    const short = await req(
      "GET",
      `/api/v1/admin/users/${TARGET}/monitoring?reason=${encodeURIComponent("太短")}`,
      TOK_ADMIN,
    );
    expect(short.status).toBe(400);

    const missingUser = await req(
      "GET",
      "/api/v1/admin/users/usr_nonexist_06b/monitoring?reason=" +
        encodeURIComponent(VIEW_REASON),
      TOK_ADMIN,
    );
    expect(missingUser.status).toBe(404);
    expect(auditRows("admin.user.monitoring_view")).toHaveLength(0);
  });

  it("带理由返回监控明细（含 target_value）+ 审计行含理由原文；邮箱仍脱敏", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req(
      "GET",
      `/api/v1/admin/users/${TARGET}/monitoring?reason=${encodeURIComponent(VIEW_REASON)}`,
      TOK_ADMIN,
    );
    expect(res.status).toBe(200);
    const b = await body(res);

    const user = b.user as Record<string, unknown>;
    expect(user.user_id).toBe(TARGET);
    expect(user.email_masked).toBe("ta***@example.com");
    expect(JSON.stringify(user)).not.toContain(TARGET_EMAIL);

    const watches = b.watches as Array<Record<string, unknown>>;
    expect(watches).toHaveLength(1);
    expect(watches[0]!.display_name_snapshot).toBe("测试小区（虚构）");
    const rules = watches[0]!.rules as Array<Record<string, unknown>>;
    expect(rules).toHaveLength(1);
    expect(rules[0]!.target_value).toBe(30000); // 受控查看：本端点唯一展示预算处

    const counts = b.counts as { watches: number; rules: number };
    expect(counts).toEqual({ watches: 1, rules: 1 });

    const rows = auditRows("admin.user.monitoring_view");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBe(VIEW_REASON);
    expect(rows[0]!.resource_id).toBe(TARGET);
    expect(rows[0]!.actor_user_id).toBe(ADMIN);
  });
});
