// TASK-07B：数据合规专项套件（任务书行 1384 / PRD 行 703、§10.3）。
// 覆盖：个人数据导出（/me/export）、注销冷静期（/me/delete-account）、
// 冷静期登录撤销（auth verify-code）、到期硬删（purgeExpiredDeletions）。
// 测试数据全虚构（example.com / TEST-*）；外部 fetch 全桩。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { purgeExpiredDeletions, DELETION_COOLDOWN_DAYS } from "./deletion";
import {
  authCookie,
  createTestEnv,
  seedUser,
  type TestContext,
} from "./test-utils/setup";

const KNOWN_OTP = "135790";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

function stubFetch(): void {
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("siteverify")) {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("apps-script.test")) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected-fetch:${url}`);
  });
  vi.stubGlobal("fetch", mock);
}

function forceOtpCode(code: string): void {
  type GetRandomValues = <T extends ArrayBufferView>(array: T) => T;
  const original = crypto.getRandomValues.bind(crypto) as GetRandomValues;
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((
    array: ArrayBufferView,
  ) => {
    if (array instanceof Uint32Array && array.length === 1) {
      array[0] = Number(code);
      return array;
    }
    return original(array);
  }) as GetRandomValues);
}

let ipSeq = 0;

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "cf-connecting-ip": `198.51.100.${(ipSeq += 1)}`,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Cookie"] = authCookie(opts.token);
  return app.request(
    path,
    {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    ctx.env,
  );
}

/** 真实 OTP 登录链路（先清该邮箱 OTP 行避免冷却干扰） */
async function loginAs(
  email: string,
): Promise<{ token: string; res: Response }> {
  forceOtpCode(KNOWN_OTP);
  ctx.priv
    .prepare("DELETE FROM email_otps WHERE email_normalized = ?")
    .run(email);
  const rc = await req("POST", "/api/v1/auth/email/request-code", {
    body: { email, turnstile_token: "test-turnstile-token" },
  });
  expect(rc.status).toBe(200);
  const vc = await req("POST", "/api/v1/auth/email/verify-code", {
    body: { email, code: KNOWN_OTP },
  });
  const m = /pr_session=([^;]+)/.exec(vc.headers.get("Set-Cookie") ?? "");
  return { token: m ? m[1]! : "", res: vc };
}

function userRow(userId: string): {
  status: string;
  deletion_requested_at: string | null;
} {
  return ctx.priv
    .prepare(
      "SELECT status, deletion_requested_at FROM users WHERE user_id = ?",
    )
    .get(userId) as { status: string; deletion_requested_at: string | null };
}

function countOf(table: string, userId: string): number {
  return (
    ctx.priv
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
      .get(userId) as { n: number }
  ).n;
}

/** 种子：用户 U 的全套个人数据（各表直插，覆盖 purge 断言面） */
function seedPersonalData(userId: string, email: string): void {
  const p = (sql: string, ...binds: string[]) =>
    ctx.priv.prepare(sql).run(...binds);
  p(
    "INSERT INTO user_cities (user_id, city_code) VALUES (?, '07B-CITY')",
    userId,
  );
  p(
    `INSERT INTO city_coverage_requests (request_id, user_id, requested_city_name)
     VALUES (?, ?, '07B-申请城市')`,
    `ccr_${userId}`,
    userId,
  );
  p(
    `INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot)
     VALUES (?, ?, 'region', 'rgn_07b', '07B-测试区域（虚构）')`,
    `w_${userId}`,
    userId,
  );
  p(
    `INSERT INTO watch_item_groups (watch_id, user_id, group_name)
     VALUES (?, ?, '07B组')`,
    `w_${userId}`,
    userId,
  );
  p(
    `INSERT INTO watch_rules (rule_id, watch_id, user_id, rule_type, metric_code, target_value, unit)
     VALUES (?, ?, ?, 'price_below', 'median_unit_price', 20000, 'yuan_sqm')`,
    `r_${userId}`,
    `w_${userId}`,
    userId,
  );
  p(
    "INSERT INTO watch_rule_settings (rule_id, user_id) VALUES (?, ?)",
    `r_${userId}`,
    userId,
  );
  p(
    `INSERT INTO alert_events (event_id, user_id, rule_id, watch_id, event_key, event_type)
     VALUES (?, ?, ?, ?, ?, 'price_crossed')`,
    `e_${userId}`,
    userId,
    `r_${userId}`,
    `w_${userId}`,
    `07b|${userId}`,
  );
  p(
    `INSERT INTO notification_deliveries (delivery_id, event_id, user_id, channel, provider, status)
     VALUES (?, ?, ?, 'email', 'apps_script', 'sent')`,
    `d_${userId}`,
    `e_${userId}`,
    userId,
  );
  p("INSERT INTO notification_preferences (user_id) VALUES (?)", userId);
  p(
    `INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, 'k', 'a')`,
    `ps_${userId}`,
    userId,
    `https://push.example.com/ep/07b-${userId}`,
  );
  p(
    `INSERT INTO user_consents (consent_id, user_id, policy_version, consent_type)
     VALUES (?, ?, 'v1.0', 'privacy_policy')`,
    `cs_${userId}`,
    userId,
  );
  p(
    `INSERT INTO email_otps (otp_id, email_normalized, code_hash, expires_at)
     VALUES (?, ?, 'hash-x', datetime('now', '+10 minutes'))`,
    `otp_${userId}`,
    email,
  );
}

beforeEach(async () => {
  ctx = createTestEnv();
  ctx.env.SESSION_SIGNING_SECRET = "test-session-secret-07b";
  ctx.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret-07b";
  ctx.env.APPS_SCRIPT_WEB_APP_URL = "https://apps-script.test/gateway";
  ctx.env.APPS_SCRIPT_HMAC_SECRET = "test-gw-hmac-07b";
  ctx.env.RATE_LIMIT_MAX = "100000";
  app = createApp();
  stubFetch();
  await seedUser(ctx.priv, "usr_07b_a", "alice-07b@example.com", "tok_07b_a");
  await seedUser(ctx.priv, "usr_07b_b", "bob-07b@example.com", "tok_07b_b");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------- 1. 个人数据导出 ----------------

describe("POST /me/export（TASK-07B 可携带权）", () => {
  it("无会话 → 401", async () => {
    const res = await req("POST", "/api/v1/me/export", { body: {} });
    expect(res.status).toBe(401);
  });

  it("导出含全部个人数据类别，且不含他人行", async () => {
    seedPersonalData("usr_07b_a", "alice-07b@example.com");
    seedPersonalData("usr_07b_b", "bob-07b@example.com");
    const res = await req("POST", "/api/v1/me/export", {
      token: "tok_07b_a",
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="property-radar-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const text = await res.clone().text();
    const payload = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      [
        "account",
        "alert_events",
        "city_coverage_requests",
        "exported_at",
        "notification_preferences",
        "push_subscriptions",
        "schema_version",
        "user_cities",
        "user_consents",
        "watch_item_groups",
        "watch_rule_settings",
        "watch_rules",
        "watch_items",
      ].sort(),
    );
    const account = payload.account as {
      user_id: string;
      email_normalized: string;
    };
    expect(account.user_id).toBe("usr_07b_a");
    expect(account.email_normalized).toBe("alice-07b@example.com");
    // 各集合含本人行
    expect((payload.watch_items as unknown[]).length).toBe(1);
    expect((payload.alert_events as unknown[]).length).toBe(1);
    expect((payload.user_consents as unknown[]).length).toBe(1);
    // 他人数据零泄露：B 的 id 不出现在导出文本
    expect(text).not.toContain("usr_07b_b");
    expect(text).not.toContain("w_usr_07b_b");
    expect(text).not.toContain("bob-07b");
  });
});

// ---------------- 2. 注销（冷静期） ----------------

describe("POST /me/delete-account（TASK-07B 注销冷静期）", () => {
  it("confirm 缺失或非 true → 400 validation_failed", async () => {
    for (const body of [{}, { confirm: false }, { confirm: "yes" }]) {
      const res = await req("POST", "/api/v1/me/delete-account", {
        token: "tok_07b_a",
        body,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error_code: string }).error_code).toBe(
        "validation_failed",
      );
    }
  });

  it("成功：标记 pending + 全部会话即时吊销 + 旧 cookie 401", async () => {
    // 第二个会话（同用户多设备）
    ctx.priv
      .prepare(
        `INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
         VALUES ('sess_07b_a2', 'usr_07b_a', 'deadbeef', datetime('now', '+1 day'))`,
      )
      .run();
    const res = await req("POST", "/api/v1/me/delete-account", {
      token: "tok_07b_a",
      body: { confirm: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "deletion_pending",
      purge_after_days: DELETION_COOLDOWN_DAYS,
    });
    const row = userRow("usr_07b_a");
    expect(row.status).toBe("deletion_pending");
    expect(row.deletion_requested_at).not.toBeNull();
    // 全部会话 revoked_at 非空
    const live = ctx.priv
      .prepare(
        "SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'usr_07b_a' AND revoked_at IS NULL",
      )
      .get() as { n: number };
    expect(live.n).toBe(0);
    // 旧 cookie 后续请求 401
    const after = await req("POST", "/api/v1/me/export", {
      token: "tok_07b_a",
      body: {},
    });
    expect(after.status).toBe(401);
  });

  it("已 pending 用户持会话再请求 → 401（requireSession 只认 active，纵深防御）", async () => {
    ctx.priv
      .prepare(
        `UPDATE users SET status = 'deletion_pending',
           deletion_requested_at = datetime('now', '-1 day')
         WHERE user_id = 'usr_07b_a'`,
      )
      .run();
    const res = await req("POST", "/api/v1/me/delete-account", {
      token: "tok_07b_a",
      body: { confirm: true },
    });
    expect(res.status).toBe(401);
    expect(userRow("usr_07b_a").status).toBe("deletion_pending");
  });

  it("活跃管理员角色 → 403 forbidden，状态不变", async () => {
    ctx.priv
      .prepare(
        `INSERT INTO admin_roles (admin_id, user_id, role, mfa_required, created_by)
         VALUES ('adm_07b', 'usr_07b_a', 'admin', 1, 'test')`,
      )
      .run();
    const res = await req("POST", "/api/v1/me/delete-account", {
      token: "tok_07b_a",
      body: { confirm: true },
    });
    expect(res.status).toBe(403);
    expect(userRow("usr_07b_a").status).toBe("active");
  });
});

// ---------------- 3. 冷静期撤销与拒绝面 ----------------

describe("冷静期登录撤销（auth verify-code）", () => {
  it("pending 用户重新登录 → 撤销注销、会话可用、响应 deletion_cancelled", async () => {
    const { token } = await loginAs("cancel-07b@example.com");
    const del = await req("POST", "/api/v1/me/delete-account", {
      token,
      body: { confirm: true },
    });
    expect(del.status).toBe(200);
    const again = await loginAs("cancel-07b@example.com");
    expect(again.res.status).toBe(200);
    expect(await again.res.json()).toMatchObject({ deletion_cancelled: true });
    const u = ctx.priv
      .prepare(
        "SELECT status, deletion_requested_at FROM users WHERE email_normalized = 'cancel-07b@example.com'",
      )
      .get() as { status: string; deletion_requested_at: string | null };
    expect(u.status).toBe("active");
    expect(u.deletion_requested_at).toBeNull();
    // 新会话可用
    const watch = await req("GET", "/api/v1/me/watch-items", {
      token: again.token,
    });
    expect(watch.status).toBe(200);
  });

  it("frozen / 管理员删除用户登录仍被拒（401 账号不可用）", async () => {
    forceOtpCode(KNOWN_OTP);
    ctx.priv
      .prepare(
        `INSERT INTO users (user_id, email_normalized, status)
         VALUES ('usr_07b_frozen', 'frozen-07b@example.com', 'frozen')`,
      )
      .run();
    ctx.priv
      .prepare(
        `INSERT INTO users (user_id, email_normalized, deleted_at)
         VALUES ('usr_07b_dead', 'dead-07b@example.com', datetime('now'))`,
      )
      .run();
    for (const email of ["frozen-07b@example.com", "dead-07b@example.com"]) {
      ctx.priv
        .prepare("DELETE FROM email_otps WHERE email_normalized = ?")
        .run(email);
      const rc = await req("POST", "/api/v1/auth/email/request-code", {
        body: { email, turnstile_token: "test-turnstile-token" },
      });
      expect(rc.status).toBe(200);
      const vc = await req("POST", "/api/v1/auth/email/verify-code", {
        body: { email, code: KNOWN_OTP },
      });
      expect(vc.status).toBe(401);
    }
  });
});

// ---------------- 4. 到期硬删 ----------------

describe("purgeExpiredDeletions（TASK-07B 到期硬删）", () => {
  function seedPendingUser(
    userId: string,
    email: string,
    ageDays: number,
  ): void {
    ctx.priv
      .prepare(
        `INSERT INTO users (user_id, email_normalized, status, deletion_requested_at)
         VALUES (?, ?, 'deletion_pending', datetime('now', ?))`,
      )
      .run(userId, email, `-${ageDays} days`);
    seedPersonalData(userId, email);
  }

  it("8 天前申请：全表个人数据删除、用户行删除、审计日志保留；6 天前保留", async () => {
    seedPendingUser("usr_07b_due", "due-07b@example.com", 8);
    seedPendingUser("usr_07b_hold", "hold-07b@example.com", 6);
    // 审计日志（actor 不设外键——注销后仍完整，0001 设计）
    ctx.priv
      .prepare(
        `INSERT INTO audit_logs (audit_id, actor_user_id, action)
         VALUES ('aud_07b', 'usr_07b_due', 'admin_delete')`,
      )
      .run();
    // 已撤销的管理员角色残留也随用户清除
    ctx.priv
      .prepare(
        `INSERT INTO admin_roles (admin_id, user_id, role, revoked_at)
         VALUES ('adm_07b_due', 'usr_07b_due', 'admin', datetime('now'))`,
      )
      .run();

    const result = await purgeExpiredDeletions(ctx.env.DB_PRIVATE);
    expect(result).toEqual({ purged: 1 });

    for (const table of [
      "watch_items",
      "watch_rules",
      "watch_rule_settings",
      "watch_item_groups",
      "alert_events",
      "notification_deliveries",
      "notification_preferences",
      "push_subscriptions",
      "user_consents",
      "city_coverage_requests",
      "user_cities",
      "sessions",
      "admin_roles",
    ]) {
      expect(countOf(table, "usr_07b_due"), `${table} 残留`).toBe(0);
    }
    expect(
      ctx.priv
        .prepare(
          "SELECT COUNT(*) AS n FROM users WHERE user_id = 'usr_07b_due'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      ctx.priv
        .prepare(
          "SELECT COUNT(*) AS n FROM email_otps WHERE email_normalized = 'due-07b@example.com'",
        )
        .get(),
    ).toEqual({ n: 0 });
    // 审计日志保留（合规追责）
    expect(
      ctx.priv
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_logs WHERE audit_id = 'aud_07b'",
        )
        .get(),
    ).toEqual({ n: 1 });
    // 未到期用户完整保留
    expect(countOf("watch_items", "usr_07b_hold")).toBe(1);
    expect(userRow("usr_07b_hold").status).toBe("deletion_pending");
  });

  it("active 用户不受影响；无到期用户 purged=0", async () => {
    seedPersonalData("usr_07b_a", "alice-07b@example.com");
    const result = await purgeExpiredDeletions(ctx.env.DB_PRIVATE);
    expect(result).toEqual({ purged: 0 });
    expect(countOf("watch_items", "usr_07b_a")).toBe(1);
  });
});
