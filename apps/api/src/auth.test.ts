// TASK-02C：邮箱 OTP 认证验收（PRD §TASK-02C / §7.1）——
// OTP 只存哈希、无邮箱枚举、超时/重放/爆破、cookie 安全属性、Turnstile、
// Apps Script HMAC 签名、滚动 24 小时配额硬上限。
// 测试数据全部虚构（example.com）；验证码经 mock 固定为 123456 仅存在于内存库。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { hmacSha256Hex } from "./crypto";
import { gatewayCanonical } from "./email/apps-script";
import { hashOtpCode, randomOtpCode, requestFingerprint } from "./otp";
import { createTestEnv, seedUser, type TestContext } from "./test-utils/setup";

const SESSION_SECRET = "test-session-secret";
const GW_SECRET = "test-gateway-secret";
const GW_URL = "https://apps-script.test/gateway";
const KNOWN_CODE = "123456";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

let turnstileSuccess = true;
let gatewayOk = true;
let gatewayCalls: Array<{ url: string; init?: RequestInit }> = [];

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 捕获外部请求：Turnstile siteverify 与 Apps Script 网关 */
function stubFetch(): void {
  gatewayCalls = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("siteverify")) {
      return jsonResponse({ success: turnstileSuccess });
    }
    if (url.includes("apps-script.test")) {
      gatewayCalls.push({ url, init });
      return jsonResponse(
        gatewayOk ? { ok: true } : { ok: false, error: "quota_exhausted" },
      );
    }
    throw new Error(`测试出现意外外部请求：${url}`);
  });
  vi.stubGlobal("fetch", mock);
}

/** 让随机 OTP 生成器产出已知码（仅测试内使用；库中仍只存哈希） */
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

function jsonHeaders(cookie?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(cookie ? { Cookie: cookie } : {}),
  };
}

async function requestCode(
  email: string,
  opts: { turnstileToken?: string } = {},
): Promise<Response> {
  return app.request(
    "/api/v1/auth/email/request-code",
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        email,
        turnstile_token: opts.turnstileToken ?? "test-turnstile-token",
      }),
    },
    ctx.env,
  );
}

async function verifyCode(email: string, code: string): Promise<Response> {
  return app.request(
    "/api/v1/auth/email/verify-code",
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ email, code }),
    },
    ctx.env,
  );
}

function gatewayInitHeaders(): Record<string, string> {
  expect(gatewayCalls.length).toBeGreaterThan(0);
  return (gatewayCalls[gatewayCalls.length - 1]?.init?.headers ?? {}) as Record<
    string,
    string
  >;
}

beforeEach(() => {
  ctx = createTestEnv();
  ctx.env.SESSION_SIGNING_SECRET = SESSION_SECRET;
  ctx.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
  ctx.env.APPS_SCRIPT_WEB_APP_URL = GW_URL;
  ctx.env.APPS_SCRIPT_HMAC_SECRET = GW_SECRET;
  turnstileSuccess = true;
  gatewayOk = true;
  app = createApp();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("请求验证码：Turnstile、配置与安全存储", () => {
  it("Turnstile 通过后发送成功；OTP 只存 HMAC 哈希，响应与库中无明文码", async () => {
    forceOtpCode(KNOWN_CODE);
    const email = "otp.user@example.com";
    const res = await requestCode(email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; message: string };
    expect(body.status).toBe("ok");
    // 响应不回显验证码
    expect(JSON.stringify(body)).not.toContain(KNOWN_CODE);

    const row = ctx.priv
      .prepare("SELECT * FROM email_otps WHERE email_normalized = ?")
      .get(email) as Record<string, unknown>;
    expect(row).toBeDefined();
    // 库中只有 64 位 hex 哈希，且不等于明文码
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.code_hash).not.toBe(KNOWN_CODE);
    // 与按密钥重算的 HMAC 完全一致
    expect(row.code_hash).toBe(
      await hashOtpCode(SESSION_SECRET, email, KNOWN_CODE),
    );
    // 整行任何字段都不含明文码
    for (const value of Object.values(row)) {
      expect(String(value)).not.toBe(KNOWN_CODE);
    }
    // 过期时间约 10 分钟后
    expect(String(row.expires_at)).toMatch(/^\d{4}-\d{2}-\d{2} /);
  });

  it("无邮箱枚举：已存在与不存在邮箱的响应完全一致", async () => {
    await seedUser(ctx.priv, "usr_exists", "exists@example.com", "tok_x");
    const known = await requestCode("exists@example.com");
    const unknown = await requestCode("unknown@example.com");
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
  });

  it("Turnstile 校验失败 → 400，且不生成 OTP、不调用邮件网关", async () => {
    turnstileSuccess = false;
    const res = await requestCode("blocked@example.com");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code: string }).error_code).toBe(
      "bad_request",
    );
    expect(gatewayCalls).toHaveLength(0);
    const row = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM email_otps")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  it("Turnstile 密钥未配置 → 503（不静默放行）", async () => {
    delete ctx.env.TURNSTILE_SECRET_KEY;
    const res = await requestCode("someone@example.com");
    expect(res.status).toBe(503);
    expect(gatewayCalls).toHaveLength(0);
  });

  it("SESSION_SIGNING_SECRET 缺失 → 503", async () => {
    delete ctx.env.SESSION_SIGNING_SECRET;
    const res = await requestCode("someone@example.com");
    expect(res.status).toBe(503);
    expect(gatewayCalls).toHaveLength(0);
  });
});

describe("请求验证码：频率限制", () => {
  it("同邮箱 60 秒内重复申请 → 429 rate_limited", async () => {
    const first = await requestCode("cooldown@example.com");
    expect(first.status).toBe(200);
    const second = await requestCode("cooldown@example.com");
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error_code: string }).error_code).toBe(
      "rate_limited",
    );
  });

  it("同邮箱 15 分钟内第 6 次申请 → 429", async () => {
    const email = "flood@example.com";
    for (let i = 0; i < 5; i += 1) {
      ctx.priv
        .prepare(
          `INSERT INTO email_otps (otp_id, email_normalized, code_hash, expires_at, created_at)
           VALUES (?, ?, 'placeholderhash', datetime('now', '+5 minutes'), datetime('now', '-10 minutes'))`,
        )
        .run(`otp_old_${i}`, email);
    }
    const res = await requestCode(email);
    expect(res.status).toBe(429);
    expect(gatewayCalls).toHaveLength(0);
  });

  it("同 IP（指纹哈希）15 分钟内第 6 次申请（换邮箱）→ 429", async () => {
    const fingerprint = await requestFingerprint(SESSION_SECRET, "unknown");
    for (let i = 0; i < 5; i += 1) {
      ctx.priv
        .prepare(
          `INSERT INTO email_otps
             (otp_id, email_normalized, code_hash, expires_at, request_fingerprint_hash, created_at)
           VALUES (?, ?, 'placeholderhash', datetime('now', '+5 minutes'), ?, datetime('now', '-10 minutes'))`,
        )
        .run(`otp_ip_${i}`, `ip.flood.${i}@example.com`, fingerprint);
    }
    const res = await requestCode("fresh@example.com");
    expect(res.status).toBe(429);
    expect(gatewayCalls).toHaveLength(0);
  });
});

describe("请求验证码：Apps Script 网关签名与失败回滚", () => {
  it("网关请求带 HMAC 签名、时间戳与 request_id，签名可重算验证", async () => {
    const res = await requestCode("sign@example.com");
    expect(res.status).toBe(200);
    const headers = gatewayInitHeaders();
    const timestamp = headers["X-PR-Timestamp"] ?? "";
    const requestId = headers["X-PR-Request-Id"] ?? "";
    const signature = headers["X-PR-Signature"] ?? "";
    expect(timestamp).toMatch(/^\d{10}$/);
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    // 时间偏差 ≤60 秒
    expect(
      Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)),
    ).toBeLessThanOrEqual(60);
    // 按规范串重算 HMAC，必须与网关收到的一致
    const body = String(gatewayCalls[gatewayCalls.length - 1]?.init?.body);
    const expected = await hmacSha256Hex(
      GW_SECRET,
      gatewayCanonical("POST", body, timestamp, requestId),
    );
    expect(signature).toBe(expected);
    // 网关只收到固定模板，正文含验证码但仅在出站链路（不落库/日志）
    const payload = JSON.parse(body) as { template: string };
    expect(payload.template).toBe("otp");
  });

  it("网关拒绝（配额耗尽）→ 503，OTP 回滚删除且不记账", async () => {
    gatewayOk = false;
    const res = await requestCode("gw.fail@example.com");
    expect(res.status).toBe(503);
    const otps = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM email_otps")
      .get() as { n: number };
    const ledger = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM email_send_ledger")
      .get() as { n: number };
    expect(otps.n).toBe(0);
    expect(ledger.n).toBe(0);
  });
});

describe("校验验证码：登录、爆破、过期与重放", () => {
  it("正确验证码 → 创建会话，cookie 安全属性正确，/auth/me 可用", async () => {
    forceOtpCode(KNOWN_CODE);
    const email = "login.user@example.com";
    expect((await requestCode(email)).status).toBe(200);
    const res = await verifyCode(email, KNOWN_CODE);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe(email);

    // cookie：HttpOnly + Secure + SameSite=Lax + Path=/
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("pr_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    // 会话落库为哈希，不存明文 token
    const token = /pr_session=([^;]+)/.exec(setCookie)?.[1] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(32);
    const sess = ctx.priv.prepare("SELECT token_hash FROM sessions").get() as {
      token_hash: string;
    };
    expect(sess.token_hash).not.toBe(token);
    expect(sess.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // users 已创建且邮箱标记已验证
    const user = ctx.priv
      .prepare(
        "SELECT user_id, email_verified_at FROM users WHERE email_normalized = ?",
      )
      .get(email) as { user_id: string; email_verified_at: string | null };
    expect(user.email_verified_at).toBeTruthy();

    // 携带 cookie 访问 /auth/me
    const me = await app.request(
      "/api/v1/auth/me",
      { method: "GET", headers: jsonHeaders(`pr_session=${token}`) },
      ctx.env,
    );
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
      email,
    );
  });

  it("错误验证码连续 5 次后锁定 → 第 6 次 429，前 5 次均为 401 且文案一致", async () => {
    forceOtpCode(KNOWN_CODE);
    const email = "brute@example.com";
    expect((await requestCode(email)).status).toBe(200);

    const bodies: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await verifyCode(email, "654321");
      expect(res.status).toBe(401);
      const { error_code: code, message } = (await res.json()) as {
        error_code: string;
        message: string;
      };
      bodies.push(JSON.stringify({ code, message }));
    }
    // 统一错误文案（不提示「用户不存在」等差异）
    expect(new Set(bodies).size).toBe(1);

    const locked = await verifyCode(email, "654321");
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error_code: string }).error_code).toBe(
      "rate_limited",
    );
  });

  it("过期验证码 → 401", async () => {
    forceOtpCode(KNOWN_CODE);
    const email = "expired@example.com";
    expect((await requestCode(email)).status).toBe(200);
    ctx.priv
      .prepare(
        "UPDATE email_otps SET expires_at = datetime('now', '-1 minute')",
      )
      .run();
    const res = await verifyCode(email, KNOWN_CODE);
    expect(res.status).toBe(401);
  });

  it("验证码单次使用：成功后重放同一码 → 401", async () => {
    forceOtpCode(KNOWN_CODE);
    const email = "replay@example.com";
    expect((await requestCode(email)).status).toBe(200);
    const first = await verifyCode(email, KNOWN_CODE);
    expect(first.status).toBe(200);
    const replay = await verifyCode(email, KNOWN_CODE);
    expect(replay.status).toBe(401);
  });

  it("无邮箱枚举：不存在邮箱的错误码与已存在邮箱响应完全一致", async () => {
    await seedUser(ctx.priv, "usr_known", "known@example.com", "tok_known");
    forceOtpCode(KNOWN_CODE);
    expect((await requestCode("known@example.com")).status).toBe(200);
    const knownWrong = await verifyCode("known@example.com", "000000");
    const unknownWrong = await verifyCode("ghost@example.com", "000000");
    expect(knownWrong.status).toBe(401);
    expect(unknownWrong.status).toBe(401);
    // 比较 error_code + message（request_id 每次不同，属预期）
    const pick = async (res: Response) => {
      const { error_code: code, message } = (await res.json()) as {
        error_code: string;
        message: string;
      };
      return { code, message };
    };
    expect(await pick(knownWrong)).toEqual(await pick(unknownWrong));
  });
});

describe("登出与会话撤销", () => {
  it("logout 撤销 session 并清除 cookie，之后 /auth/me 返回 401", async () => {
    forceOtpCode(KNOWN_CODE);
    const email = "logout.user@example.com";
    expect((await requestCode(email)).status).toBe(200);
    const login = await verifyCode(email, KNOWN_CODE);
    const token = /pr_session=([^;]+)/.exec(
      login.headers.get("set-cookie") ?? "",
    )?.[1];
    expect(token).toBeTruthy();

    const logout = await app.request(
      "/api/v1/auth/logout",
      {
        method: "POST",
        headers: jsonHeaders(`pr_session=${token}`),
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(logout.status).toBe(200);
    expect(((await logout.json()) as { logged_out: boolean }).logged_out).toBe(
      true,
    );
    // 清除指令使 cookie 过期
    const cleared = logout.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("pr_session=");
    expect(/max-age=0|1970/i.test(cleared)).toBe(true);

    // 库内会话已撤销
    const sess = ctx.priv.prepare("SELECT revoked_at FROM sessions").get() as {
      revoked_at: string | null;
    };
    expect(sess.revoked_at).toBeTruthy();

    // 撤销后原 token 不再有效
    const me = await app.request(
      "/api/v1/auth/me",
      { method: "GET", headers: jsonHeaders(`pr_session=${token}`) },
      ctx.env,
    );
    expect(me.status).toBe(401);
  });
});

describe("邮件配额硬上限（免费红线）", () => {
  it("滚动 24 小时达到 EMAIL_DAILY_HARD_CAP 后不再请求邮件商", async () => {
    ctx.env.EMAIL_DAILY_HARD_CAP = "1";
    const first = await requestCode("cap.one@example.com");
    expect(first.status).toBe(200);
    expect(gatewayCalls).toHaveLength(1);

    // 换邮箱避开冷却，额度检查应在调用邮件商之前拦截
    const second = await requestCode("cap.two@example.com");
    expect(second.status).toBe(429);
    const body = (await second.json()) as { message: string };
    expect(body.message).toContain("额度");
    // 关键红线：第二次没有再调用邮件网关
    expect(gatewayCalls).toHaveLength(1);
  });

  it("OTP 专属预算 OTP_DAILY_RESERVED_CAP 独立生效", async () => {
    ctx.env.OTP_DAILY_RESERVED_CAP = "1";
    expect((await requestCode("otp.cap1@example.com")).status).toBe(200);
    const second = await requestCode("otp.cap2@example.com");
    expect(second.status).toBe(429);
    expect(gatewayCalls).toHaveLength(1);
  });
});

describe("OTP 生成器形态", () => {
  it("产出 6 位数字且多次调用不完全相同", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const code = randomOtpCode();
      expect(code).toMatch(/^\d{6}$/);
      samples.add(code);
    }
    expect(samples.size).toBeGreaterThan(1);
  });
});
