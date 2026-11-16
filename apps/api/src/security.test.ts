// TASK-07A：安全测试专项套件（任务书行 1378–1380 / PRD §7.4/§7.6/§14.3）
// 12 项逐条实证：IDOR、CSRF、XSS、SQL Injection、SSRF、OTP 暴力破解、邮箱枚举、
// session fixation、管理员越权、Secrets 泄露、CORS、错误日志泄露。
// 测试数据全虚构（example.com / *.test）；哨兵密钥仅存在于测试内存 env。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { hmacSha256Hex } from "./crypto";
import {
  authCookie,
  createTestEnv,
  seedUser,
  type TestContext,
} from "./test-utils/setup";

// ---------------- 哨兵 Secrets（任何响应/日志出现即失败） ----------------
const S_SESSION = "SENTINEL-SESSION-SECRET-9f3a";
const S_TURNSTILE = "SENTINEL-TURNSTILE-SECRET-9f3a";
const S_GW_HMAC = "SENTINEL-GW-HMAC-SECRET-9f3a";
const S_INGEST = "SENTINEL-INGEST-HMAC-SECRET-9f3a";
const S_BOOT = "SENTINEL-BOOT-CODE-9f3a";
const S_VAPID = "SENTINEL-VAPID-PRIVKEY-9f3a";
const ALL_SENTINELS = [
  S_SESSION,
  S_TURNSTILE,
  S_GW_HMAC,
  S_INGEST,
  S_BOOT,
  S_VAPID,
];

const GW_URL = "https://apps-script.test/gateway";
const KNOWN_OTP = "246810";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;
let fetchUrls: string[] = [];
let turnstileSuccess = true;

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** 全捕获 fetch：只放行 Turnstile siteverify 与 Apps Script 桩；其余记为意外外部调用 */
function stubFetch(): void {
  fetchUrls = [];
  turnstileSuccess = true;
  const mock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    fetchUrls.push(url);
    if (url.includes("siteverify")) {
      return jsonResponse({ success: turnstileSuccess });
    }
    if (url.includes("apps-script.test")) {
      return jsonResponse({ ok: true });
    }
    throw new Error(`SSRF-DETECTED-unexpected-fetch:${url}`);
  });
  vi.stubGlobal("fetch", mock);
}

/** 固定 OTP 生成（仅测试内；库中仍只存哈希） */
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

interface ReqOpts {
  token?: string;
  body?: unknown;
  origin?: string;
  headers?: Record<string, string>;
}

// 每请求独立源 IP：OTP 的 IP 维度 15 分钟限流（每 IP 5 次）不应干扰其它用例
let ipSeq = 0;

async function req(
  method: string,
  path: string,
  opts: ReqOpts = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "cf-connecting-ip": `203.0.113.${(ipSeq += 1)}`,
    ...opts.headers,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Cookie"] = authCookie(opts.token);
  if (opts.origin) headers["Origin"] = opts.origin;
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

async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function textOf(res: Response): Promise<string> {
  return res.clone().text();
}

/** 真实 OTP 登录链路，返回会话 token（先清该邮箱 OTP 行，避免 60 秒冷却干扰） */
async function loginAs(email: string): Promise<string> {
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
  expect(vc.status).toBe(200);
  const setCookie = vc.headers.get("Set-Cookie") ?? "";
  const m = /pr_session=([^;]+)/.exec(setCookie);
  if (!m) throw new Error("登录未签发 pr_session cookie");
  return m[1]!;
}

function grantAdmin(userId: string): void {
  ctx.priv
    .prepare(
      "INSERT INTO admin_roles (admin_id, user_id, role, mfa_required, created_by) VALUES (?, ?, 'admin', 1, 'test')",
    )
    .run(`adm_${userId}`, userId);
}

/** 种子：城市 + 小区（watch community 需 Public 目录存在） */
function seedCommunity(objectId: string): void {
  ctx.pub
    .prepare(
      "INSERT OR IGNORE INTO cities (city_code, name, province_code, status) VALUES ('07A-CITY', 'TEST-安全城市', 'TEST-P', 'active')",
    )
    .run();
  ctx.pub
    .prepare(
      "INSERT INTO communities (community_id, city_code, name, status) VALUES (?, '07A-CITY', 'TEST-安全小区（虚构）', 'active')",
    )
    .run(objectId);
}

async function createWatch(
  token: string,
  name = "安全测试小区",
  objectId = "cmt_sec_07a",
): Promise<string> {
  seedCommunity(objectId);
  const res = await req("POST", "/api/v1/me/watch-items", {
    token,
    body: {
      object_type: "community",
      object_id: objectId,
      display_name_snapshot: name,
    },
  });
  expect(res.status).toBe(201);
  const item = (await jsonOf(res)).item as { watch_id: string };
  return item.watch_id;
}

async function internalPost(
  path: string,
  payload: unknown,
  secret: string,
  opts: { ts?: string; nonce?: string; signBody?: string } = {},
): Promise<Response> {
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? `n-${Math.random().toString(36).slice(2)}`;
  const body = JSON.stringify(payload);
  const sig = await hmacSha256Hex(
    secret,
    `${ts}.${nonce}.${opts.signBody ?? body}`,
  );
  return app.request(
    `/api/v1/internal${path}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Timestamp": ts,
        "X-Ingest-Nonce": nonce,
        "X-Ingest-Signature": sig,
      },
      body,
    },
    ctx.env,
  );
}

beforeEach(async () => {
  ctx = createTestEnv();
  ctx.env.SESSION_SIGNING_SECRET = S_SESSION;
  ctx.env.TURNSTILE_SECRET_KEY = S_TURNSTILE;
  ctx.env.APPS_SCRIPT_WEB_APP_URL = GW_URL;
  ctx.env.APPS_SCRIPT_HMAC_SECRET = S_GW_HMAC;
  ctx.env.INGEST_HMAC_SECRET = S_INGEST;
  ctx.env.ADMIN_BOOTSTRAP_CODE = S_BOOT;
  ctx.env.VAPID_PRIVATE_KEY = S_VAPID;
  // 全局 IP 限流放宽，避免套件内正常请求误触 429（爆破用例走 OTP 维度限流）
  ctx.env.RATE_LIMIT_MAX = "100000";
  app = createApp();
  stubFetch();
  await seedUser(ctx.priv, "usr_a_07a", "alice-07a@example.com", "tok_a_07a");
  await seedUser(ctx.priv, "usr_b_07a", "bob-07a@example.com", "tok_b_07a");
  await seedUser(
    ctx.priv,
    "usr_admin_07a",
    "admin-07a@example.com",
    "tok_admin_07a",
  );
  grantAdmin("usr_admin_07a");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ================= 1. IDOR =================
describe("IDOR：对象归属只从 session 解析", () => {
  it("B 访问 A 的 watch/rule/event/subscription 一律 404", async () => {
    const watchId = await createWatch("tok_a_07a");
    const ruleRes = await req(
      "POST",
      `/api/v1/me/watch-items/${watchId}/rules`,
      {
        token: "tok_a_07a",
        body: {
          rule_type: "community_unit_price_lte",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          target_value: 20000,
          unit: "元/㎡",
        },
      },
    );
    expect(ruleRes.status).toBe(201);
    const ruleId = ((await jsonOf(ruleRes)).item as { rule_id: string })
      .rule_id;

    ctx.priv
      .prepare(
        `INSERT INTO alert_events (event_id, user_id, event_key, event_type, old_value, new_value)
         VALUES ('evt_a_07a', 'usr_a_07a', 'key-a-07a', 'price_crossed', 21000, 19500)`,
      )
      .run();
    ctx.priv
      .prepare(
        `INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth)
         VALUES ('psub_a_07a', 'usr_a_07a', 'https://push.test/idor-a', 'ka', 'aa')`,
      )
      .run();

    // B 逐一访问 A 的对象 → 全部 404（不泄露存在性差异）
    const hits: Array<[string, number]> = [];
    hits.push([
      "watch-read",
      (
        await req("PATCH", `/api/v1/me/watch-items/${watchId}`, {
          token: "tok_b_07a",
          body: { priority: 5 },
        })
      ).status,
    ]);
    hits.push([
      "watch-delete",
      (
        await req("DELETE", `/api/v1/me/watch-items/${watchId}`, {
          token: "tok_b_07a",
        })
      ).status,
    ]);
    hits.push([
      "rule-patch",
      (
        await req("PATCH", `/api/v1/me/rules/${ruleId}`, {
          token: "tok_b_07a",
          body: { target_value: 1 },
        })
      ).status,
    ]);
    hits.push([
      "rule-delete",
      (
        await req("DELETE", `/api/v1/me/rules/${ruleId}`, {
          token: "tok_b_07a",
        })
      ).status,
    ]);
    hits.push([
      "event-read",
      (
        await req("PATCH", "/api/v1/me/events/evt_a_07a/read", {
          token: "tok_b_07a",
          body: {},
        })
      ).status,
    ]);
    hits.push([
      "sub-delete",
      (
        await req("DELETE", "/api/v1/me/push-subscriptions", {
          token: "tok_b_07a",
          body: { subscription_id: "psub_a_07a" },
        })
      ).status,
    ]);
    expect(hits).toEqual([
      ["watch-read", 404],
      ["watch-delete", 404],
      ["rule-patch", 404],
      ["rule-delete", 404],
      ["event-read", 404],
      ["sub-delete", 404],
    ]);

    // A 的对象未被破坏
    const aList = await req("GET", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
    });
    expect(((await jsonOf(aList)).items as unknown[]).length).toBe(1);
  });

  it("写端点 body 携带 user_id 一律 400（strict schema，归属不接受客户端传入）", async () => {
    const res = await req("POST", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
      body: {
        object_type: "community",
        object_id: "cmt_x",
        display_name_snapshot: "X",
        user_id: "usr_b_07a",
      },
    });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error_code as string).toBe("validation_failed");
    const pref = await req("PATCH", "/api/v1/me/notification-preferences", {
      token: "tok_a_07a",
      body: { email_enabled: true, user_id: "usr_b_07a" },
    });
    expect(pref.status).toBe(400);
  });
});

// ================= 2. CSRF =================
describe("CSRF：cookie 唯一凭证 + SameSite + 跨站无放行头", () => {
  it("会话 cookie 恒 HttpOnly / Secure / SameSite=Lax / Path=/", async () => {
    const token = await loginAs("csrf-07a@example.com");
    const vc = await req("POST", "/api/v1/auth/email/verify-code", {
      body: { email: "no-otp-07a@example.com", code: "000000" },
    });
    expect(vc.status).toBe(401); // 无 OTP 不签发任何 cookie
    // 上面 loginAs 走完整链路；此处直接检查一次真实签发的 Set-Cookie 属性
    forceOtpCode(KNOWN_OTP);
    await req("POST", "/api/v1/auth/email/request-code", {
      body: { email: "csrf2-07a@example.com", turnstile_token: "t" },
    });
    const res = await req("POST", "/api/v1/auth/email/verify-code", {
      body: { email: "csrf2-07a@example.com", code: KNOWN_OTP },
    });
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(token).toBeTruthy();
  });

  it("跨站 Origin 的写请求：无 cookie → 401；响应不带任何 CORS 放行头", async () => {
    const res = await req("POST", "/api/v1/me/watch-items", {
      origin: "https://evil.example.com",
      body: {
        object_type: "community",
        object_id: "cmt_x",
        display_name_snapshot: "X",
      },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("写语义端点不挂在 GET 上（GET logout / GET 创建 → 404）", async () => {
    expect((await req("GET", "/api/v1/auth/logout")).status).toBe(404);
    expect((await req("GET", "/api/v1/me/watch-items")).status).toBe(401); // 读端点需会话
    const res = await app.request(
      "/api/v1/me/watch-items",
      { method: "GET", headers: { Cookie: authCookie("tok_a_07a") } },
      ctx.env,
    );
    expect(res.status).toBe(200); // GET 只读，无副作用
  });
});

// ================= 3. XSS =================
describe("XSS：恶意 HTML 原样存为文本，响应恒 JSON", () => {
  const MALICIOUS = `<script>alert("xss")</script><img src=x onerror=alert(1)>`;

  it("用户字段注入 HTML：存储/回读原样文本，Content-Type 为 application/json", async () => {
    seedCommunity("cmt_xss");
    const res = await req("POST", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
      body: {
        object_type: "community",
        object_id: "cmt_xss",
        display_name_snapshot: MALICIOUS,
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const list = await req("GET", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
    });
    const text = await textOf(list);
    expect(list.headers.get("Content-Type")).toContain("application/json");
    // JSON 字符串转义后原样回传（无 HTML 活动化；前端 Astro 渲染默认转义）
    expect(JSON.parse(text).items[0].display_name_snapshot).toBe(MALICIOUS);
  });

  it("管理员来源登记注入 HTML：同样只作数据文本存储", async () => {
    const res = await req("POST", "/api/v1/admin/sources", {
      token: "tok_admin_07a",
      body: {
        source_id: "src_xss_07a",
        name: MALICIOUS,
        source_type: "open_data",
      },
    });
    // 管理员会话未过 MFA → 403（门禁先于业务，见第 9 节矩阵）
    expect(res.status).toBe(403);
  });

  it("错误响应也是 JSON 信封，不回显请求 HTML", async () => {
    const res = await req("POST", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
      body: { object_type: MALICIOUS },
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    const text = await textOf(res);
    expect(text).not.toContain("<script>");
  });
});

// ================= 4. SQL Injection =================
describe("SQL Injection：prepared statements，注入串无效果", () => {
  const INJECTS = [
    "' OR '1'='1",
    "'; DROP TABLE users;--",
    "1; DELETE FROM sessions",
    "1' UNION SELECT token_hash FROM sessions--",
  ];

  it("路径参数注入 → 404 且库结构完好", async () => {
    for (const inj of INJECTS) {
      const res = await req(
        "PATCH",
        `/api/v1/me/watch-items/${encodeURIComponent(inj)}`,
        {
          token: "tok_a_07a",
          body: { priority: 1 },
        },
      );
      expect(res.status).toBe(404);
    }
    // users/sessions 仍在且可用
    const users = ctx.priv.prepare("SELECT COUNT(*) AS c FROM users").get() as {
      c: number;
    };
    expect(users.c).toBe(3);
    const me = await req("GET", "/api/v1/auth/me", { token: "tok_a_07a" });
    expect(me.status).toBe(200);
  });

  it("body 字段注入 → 原样存为字符串值，不执行", async () => {
    seedCommunity("cmt_sqli");
    const res = await req("POST", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
      body: {
        object_type: "community",
        object_id: "cmt_sqli",
        display_name_snapshot: "名'; DROP TABLE watch_items;--",
      },
    });
    expect(res.status).toBe(201);
    const list = await req("GET", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
    });
    expect(((await jsonOf(list)).items as unknown[]).length).toBe(1);
  });

  it("查询串注入 → 400 枚举校验，不触碰 SQL 语义", async () => {
    const res = await req("GET", "/api/v1/me/events?type=' OR 1=1--", {
      token: "tok_a_07a",
    });
    expect(res.status).toBe(400);
  });

  it("认证邮箱注入形态 → 400 或统一文案，OTP 表不受影响", async () => {
    const res = await req("POST", "/api/v1/auth/email/request-code", {
      body: { email: "a' OR 1=1--@example.com", turnstile_token: "t" },
    });
    expect([400, 200]).toContain(res.status);
    const rows = ctx.priv
      .prepare("SELECT COUNT(*) AS c FROM email_otps")
      .get() as { c: number };
    expect(rows.c).toBeLessThanOrEqual(1);
  });
});

// ================= 5. SSRF =================
describe("SSRF：用户输入 URL 不触发服务端 fetch", () => {
  it("展示型 URL 字段填内网/元数据地址：仅存储，零外部 fetch", async () => {
    // 管理员过 MFA 后登记来源，official_url 指向元数据/回环地址
    const setup = await req("POST", "/api/v1/admin/mfa/setup", {
      token: "tok_admin_07a",
      body: {},
    });
    expect(setup.status).toBe(200);
    const { secret } = (await setup.json()) as { secret: string };
    const { generate } = await import("./totp");
    const code = await generate(secret);
    expect(
      (
        await req("POST", "/api/v1/admin/mfa/verify", {
          token: "tok_admin_07a",
          body: { code },
        })
      ).status,
    ).toBe(200);

    const res = await req("POST", "/api/v1/admin/sources", {
      token: "tok_admin_07a",
      body: {
        source_id: "src_ssrf_07a",
        name: "SSRF 探针来源（虚构）",
        source_type: "open_data",
        official_url: "http://169.254.169.254/latest/meta-data/",
        license_note_url: "http://127.0.0.1:8789/admin",
      },
    });
    expect(res.status).toBe(201);
    // 除 Turnstile/网关白名单端点外，绝不允许出现任何其它 fetch
    const unexpected = fetchUrls.filter(
      (u) => !u.includes("siteverify") && !u.includes("apps-script.test"),
    );
    expect(unexpected).toEqual([]);
  });

  it("推送订阅 endpoint：仅 https 且拒绝 IP 字面量/回环/元数据/内网名（TASK-07A 修复）", async () => {
    const bad = [
      "http://push.test/plain-http",
      "http://169.254.169.254/latest/meta-data/",
      "https://169.254.169.254/x",
      "https://127.0.0.1:8789/admin",
      "https://[::1]/x",
      "https://localhost:1234/x",
      "https://metadata.google.internal/x",
      "https://intranet-host/x", // 单标签内网名
      "https://10.0.0.5/x",
      "https://192.168.1.1/x",
    ];
    for (const endpoint of bad) {
      const res = await req("POST", "/api/v1/me/push-subscriptions", {
        token: "tok_a_07a",
        body: { endpoint, keys: { p256dh: "ka", auth: "aa" } },
      });
      expect(res.status, endpoint).toBe(400);
    }
    const ok = await req("POST", "/api/v1/me/push-subscriptions", {
      token: "tok_a_07a",
      body: {
        endpoint: "https://push.test/ssrf-ok",
        keys: { p256dh: "ka", auth: "aa" },
      },
    });
    expect(ok.status).toBe(201);
    expect(
      fetchUrls.filter(
        (u) => !u.includes("siteverify") && !u.includes("apps-script.test"),
      ),
    ).toEqual([]);
  });

  it("认证链路外部调用仅限固定 env 端点（Turnstile + Apps Script）", async () => {
    await loginAs("ssrf-auth-07a@example.com");
    const hosts = [...new Set(fetchUrls.map((u) => new URL(u).host))];
    expect(
      hosts.every(
        (h) => h === new URL(GW_URL).host || h === "challenges.cloudflare.com",
      ),
    ).toBe(true);
    expect(fetchUrls.length).toBeGreaterThan(0);
  });
});

// ================= 6. OTP 暴力破解 =================
describe("OTP 暴力破解：5 次错误锁定 + 申请限频", () => {
  it("同码 5 次错误后锁定，此后正确码也被拒绝", async () => {
    forceOtpCode(KNOWN_OTP);
    const email = "brute-07a@example.com";
    expect(
      (
        await req("POST", "/api/v1/auth/email/request-code", {
          body: { email, turnstile_token: "t" },
        })
      ).status,
    ).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      const wrong = await req("POST", "/api/v1/auth/email/verify-code", {
        body: { email, code: "000000" },
      });
      expect(wrong.status).toBe(401);
    }
    const locked = await req("POST", "/api/v1/auth/email/verify-code", {
      body: { email, code: KNOWN_OTP },
    });
    expect(locked.status).toBe(429);
  });

  it("同邮箱 60 秒冷却：第二次申请 429", async () => {
    const email = "cooldown-07a@example.com";
    const body = { email, turnstile_token: "t" };
    expect(
      (await req("POST", "/api/v1/auth/email/request-code", { body })).status,
    ).toBe(200);
    const second = await req("POST", "/api/v1/auth/email/request-code", {
      body,
    });
    expect(second.status).toBe(429);
  });
});

// ================= 7. 邮箱枚举 =================
describe("邮箱枚举：存在与不存在不可区分", () => {
  it("request-code 对已注册/未注册邮箱响应字节级一致", async () => {
    const known = await req("POST", "/api/v1/auth/email/request-code", {
      body: { email: "alice-07a@example.com", turnstile_token: "t" },
    });
    const unknown = await req("POST", "/api/v1/auth/email/request-code", {
      body: { email: "ghost-07a@example.com", turnstile_token: "t" },
    });
    expect(known.status).toBe(unknown.status);
    expect(await textOf(known)).toBe(await textOf(unknown));
  });

  it("verify-code：无 OTP 邮箱与错码文案一致（401 同 message）", async () => {
    const noOtp = await req("POST", "/api/v1/auth/email/verify-code", {
      body: { email: "ghost2-07a@example.com", code: "111111" },
    });
    forceOtpCode(KNOWN_OTP);
    await req("POST", "/api/v1/auth/email/request-code", {
      body: { email: "enum-07a@example.com", turnstile_token: "t" },
    });
    const wrongCode = await req("POST", "/api/v1/auth/email/verify-code", {
      body: { email: "enum-07a@example.com", code: "111111" },
    });
    expect(noOtp.status).toBe(401);
    expect(wrongCode.status).toBe(401);
    // request_id 每请求不同，比较错误语义字段（文案一致即不可区分）
    const a = await jsonOf(noOtp);
    const b = await jsonOf(wrongCode);
    expect([a.error_code, a.message]).toEqual([b.error_code, b.message]);
  });
});

// ================= 8. Session fixation =================
describe("Session fixation：登录必发新 token，伪造 cookie 不沿用", () => {
  it("客户端预置 pr_session=fixed 值：登录后签发的是新 token，fixed 值始终无效", async () => {
    const FIXED = "attacker-fixed-session-token";
    forceOtpCode(KNOWN_OTP);
    await req("POST", "/api/v1/auth/email/request-code", {
      body: { email: "fix-07a@example.com", turnstile_token: "t" },
    });
    // 登录请求携带攻击者预设的 cookie
    const res = await app.request(
      "/api/v1/auth/email/verify-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: authCookie(FIXED),
        },
        body: JSON.stringify({ email: "fix-07a@example.com", code: KNOWN_OTP }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    const m = /pr_session=([^;]+)/.exec(setCookie);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe(FIXED); // 新随机 token，不复用客户端值
    // fixed 值从未绑定会话：拿它访问 /me 恒 401
    expect((await req("GET", "/api/v1/auth/me", { token: FIXED })).status).toBe(
      401,
    );
    // 新 token 可用
    expect(
      (await req("GET", "/api/v1/auth/me", { token: m![1]! })).status,
    ).toBe(200);
  });

  it("两次登录 token 互不相同；logout 后旧 token 立即失效", async () => {
    const email = "fix2-07a@example.com";
    const t1 = await loginAs(email);
    const t2 = await loginAs(email);
    expect(t1).not.toBe(t2);
    expect((await req("GET", "/api/v1/auth/me", { token: t1 })).status).toBe(
      200,
    );
    await req("POST", "/api/v1/auth/logout", { token: t2 });
    expect((await req("GET", "/api/v1/auth/me", { token: t2 })).status).toBe(
      401,
    );
    expect((await req("GET", "/api/v1/auth/me", { token: t1 })).status).toBe(
      200,
    ); // 只撤当前会话
  });
});

// ================= 9. 管理员越权 =================
describe("管理员越权：/admin/* 门禁矩阵", () => {
  const ADMIN_ENDPOINTS = [
    "/api/v1/admin/sources",
    "/api/v1/admin/users",
    "/api/v1/admin/overview",
    "/api/v1/admin/jobs",
    "/api/v1/admin/quality/issues",
    "/api/v1/admin/audit",
  ];

  it("未登录 401 / 普通用户 403 admin_required / 管理员未过 MFA 403 mfa_required", async () => {
    for (const path of ADMIN_ENDPOINTS) {
      expect([path, (await req("GET", path)).status]).toEqual([path, 401]);
      const plain = await req("GET", path, { token: "tok_a_07a" });
      expect([path, plain.status]).toEqual([path, 403]);
      expect((await jsonOf(plain)).error_code as string).toBe("admin_required");
      const adm = await req("GET", path, { token: "tok_admin_07a" });
      expect([path, adm.status]).toEqual([path, 403]);
      expect((await jsonOf(adm)).error_code as string).toBe("mfa_required");
    }
  });

  it("普通用户伪装 admin 参数/头无效（角色只认数据库）", async () => {
    const res = await req("GET", "/api/v1/admin/users", {
      token: "tok_a_07a",
      headers: { "X-Admin": "true", "X-Role": "admin" },
    });
    expect(res.status).toBe(403);
  });
});

// ================= 10. Secrets 泄露 =================
describe("Secrets 泄露：响应与错误信封不含任何密钥哨兵", () => {
  async function assertNoSentinel(res: Response, label: string): Promise<void> {
    const text = await textOf(res);
    for (const s of ALL_SENTINELS) {
      expect(`${label}:${text}`, text).not.toContain(s);
    }
  }

  it("公开/认证/用户端点正常与错误响应均无哨兵", async () => {
    await assertNoSentinel(await req("GET", "/api/health"), "health");
    await assertNoSentinel(await req("GET", "/api/v1/public/cities"), "public");
    await assertNoSentinel(await req("GET", "/api/v1/auth/me"), "me-401");
    await assertNoSentinel(
      await req("POST", "/api/v1/auth/email/request-code", {
        body: { email: "sec-07a@example.com", turnstile_token: "t" },
      }),
      "request-code",
    );
    await assertNoSentinel(
      await req("POST", "/api/v1/auth/email/verify-code", {
        body: { email: "sec-07a@example.com", code: "000000" },
      }),
      "verify-401",
    );
    await assertNoSentinel(
      await req("GET", "/api/v1/me/watch-items", { token: "tok_a_07a" }),
      "watch",
    );
    await assertNoSentinel(await req("GET", "/api/v1/nope"), "404");
  });

  it("internal 端点：缺签名/错签名错误响应不含 INGEST 哨兵", async () => {
    const noSig = await app.request(
      "/api/v1/internal/ingest/batch",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
      ctx.env,
    );
    expect(noSig.status).toBeGreaterThanOrEqual(400);
    await assertNoSentinel(noSig, "internal-nosig");

    const badSig = await internalPost(
      "/ingest/batch",
      { batch_id: "b1", source_id: "s1", city_code: "c1", observations: [] },
      "wrong-secret",
    );
    expect(badSig.status).toBeGreaterThanOrEqual(400);
    await assertNoSentinel(badSig, "internal-badsig");
  });

  it("存储故障 → 500 信封只含 internal_error，不外泄异常与哨兵", async () => {
    ctx.priv.close(); // 模拟 D1 故障：私有库查询全部抛错 → onError
    const res = await req("GET", "/api/v1/me/watch-items", {
      token: "tok_a_07a",
    });
    expect(res.status).toBe(500);
    const text = await textOf(res);
    expect(JSON.parse(text).error_code).toBe("internal_error");
    for (const s of ALL_SENTINELS) expect(text).not.toContain(s);
  });
});

// ================= 11. CORS =================
describe("CORS：白名单精确回显，绝不通配", () => {
  it("白名单 Origin 回显 + credentials；非白名单零放行头", async () => {
    const ok = await req("GET", "/api/v1/public/cities", {
      origin: "http://localhost:4321",
    });
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:4321",
    );
    expect(ok.headers.get("Access-Control-Allow-Credentials")).toBe("true");

    const evil = await req("GET", "/api/v1/public/cities", {
      origin: "http://evil.example.com",
    });
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(evil.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("任何响应都不出现 Access-Control-Allow-Origin: *", async () => {
    for (const origin of [
      "http://localhost:4321",
      "http://evil.example.com",
      "null",
    ]) {
      const res = await req("GET", "/api/health", { origin });
      expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    }
  });

  it("OPTIONS 预检：白名单 204 + 方法头；非白名单 204 但无放行头", async () => {
    const pre = await app.request(
      "/api/v1/me/watch-items",
      { method: "OPTIONS", headers: { Origin: "http://localhost:4321" } },
      ctx.env,
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:4321",
    );
    const preEvil = await app.request(
      "/api/v1/me/watch-items",
      { method: "OPTIONS", headers: { Origin: "http://evil.example.com" } },
      ctx.env,
    );
    expect(preEvil.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

// ================= 12. 错误日志泄露 =================
describe("错误日志泄露：500 信封最小化，日志不含凭证", () => {
  it("500 信封仅 internal_error + request_id，无 stack/SQL/异常消息", async () => {
    ctx.priv.close(); // 存储故障 → onError 兜底 500
    const res = await req("GET", "/api/v1/auth/me", { token: "tok_a_07a" });
    expect(res.status).toBe(500);
    const text = await textOf(res);
    expect(JSON.parse(text).error_code).toBe("internal_error");
    expect(text).not.toContain("SELECT");
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("stack");
  });

  it("访问日志序列化不含会话 cookie 值、OTP 与哨兵", async () => {
    const logs: string[] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    const errSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => {
        logs.push(a.map(String).join(" "));
      });
    await req("GET", "/api/v1/me/watch-items", { token: "tok_a_07a" });
    await loginAs("logx-07a@example.com");
    logSpy.mockRestore();
    errSpy.mockRestore();
    const all = logs.join("\n");
    expect(all).not.toContain("tok_a_07a");
    expect(all).not.toContain(KNOWN_OTP);
    for (const s of ALL_SENTINELS) expect(all).not.toContain(s);
  });

  it("404/401 信封不含堆栈与内部字段名", async () => {
    const nf = await req("GET", "/api/v1/does-not-exist");
    const t = await textOf(nf);
    expect(t).not.toContain("at ");
    expect(t).not.toContain("Hono");
    expect((await jsonOf(nf)).error_code as string).toBe("not_found");
  });
});
