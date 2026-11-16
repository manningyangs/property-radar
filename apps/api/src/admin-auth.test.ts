// TASK-06A：后台认证与权限验收（PRD 任务行 1346–1352 / §10.5 / §8.4）
// 覆盖：401/403/mfa_required 门禁矩阵、bootstrap 三态与幂等、TOTP setup→verify→disable 全流程、
//       重放拒绝、新会话需重验、GET /admin/audit 分页与筛选、敏感操作审计落行。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { sha256Hex } from "./auth";
import { generate } from "./totp";
import {
  authCookie,
  createTestEnv,
  seedUser,
  type TestContext,
} from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const BOOT_CODE = "b00t-c0de-06a-TEST-SECRET";
const TOK_ADMIN = "tok-admin-06a";
const TOK_USER = "tok-user-06a";
const TOK_TARGET = "tok-target-06a";
const ADMIN = "usr-admin-06a";
const USER = "usr-plain-06a";
const TARGET = "usr-target-06a";

beforeEach(async () => {
  ctx = createTestEnv();
  ctx.env.ADMIN_BOOTSTRAP_CODE = BOOT_CODE;
  app = createApp();
  await seedUser(ctx.priv, ADMIN, "admin-06a@example.com", TOK_ADMIN);
  await seedUser(ctx.priv, USER, "user-06a@example.com", TOK_USER);
  await seedUser(ctx.priv, TARGET, "target-06a@example.com", TOK_TARGET);
  grantAdmin(ADMIN);
});

function grantAdmin(userId: string): void {
  ctx.priv
    .prepare(
      "INSERT INTO admin_roles (admin_id, user_id, role, mfa_required, created_by) VALUES (?, ?, 'admin', 1, 'test')",
    )
    .run(`adm_${userId}`, userId);
}

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

/** setup → verify 走真实接口流，返回可用的管理员会话 */
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

/** 从 setup 响应取 secret 并返回其当前有效验证码 */
async function setupAndCode(token: string): Promise<string> {
  const setup = await req("POST", "/api/v1/admin/mfa/setup", token, {});
  expect(setup.status).toBe(200);
  const { secret } = (await setup.json()) as { secret: string };
  return generate(secret);
}

function auditRows(action?: string): Array<Record<string, unknown>> {
  const rows = action
    ? ctx.priv
        .prepare(
          "SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at",
        )
        .all(action)
    : ctx.priv.prepare("SELECT * FROM audit_logs ORDER BY created_at").all();
  return rows as unknown as Array<Record<string, unknown>>;
}

// ---------------- 门禁矩阵 ----------------

describe("门禁矩阵（任务书验收：普通用户直接请求 admin API → 403）", () => {
  it("未登录 → 401 unauthorized；普通用户 → 403 admin_required", async () => {
    const anon = await req("GET", "/api/v1/admin/sources");
    expect(anon.status).toBe(401);
    expect((await body(anon)).error_code).toBe("unauthorized");

    const plain = await req("GET", "/api/v1/admin/sources", TOK_USER);
    expect(plain.status).toBe(403);
    expect((await body(plain)).error_code).toBe("admin_required");
  });

  it("管理员会话未过 MFA → 403 mfa_required；过 MFA 后放行 200", async () => {
    const blocked = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error_code).toBe("mfa_required");

    await enableMfa(TOK_ADMIN);
    const ok = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    expect(ok.status).toBe(200);
  });

  it("mfa/setup、mfa/status 豁免 MFA 但仍需会话与角色（普通用户 403）", async () => {
    const plain = await req("POST", "/api/v1/admin/mfa/setup", TOK_USER, {});
    expect(plain.status).toBe(403);
    expect((await body(plain)).error_code).toBe("admin_required");
    const anon = await req("GET", "/api/v1/admin/mfa/status");
    expect(anon.status).toBe(401);
    // 管理员无需 MFA 即可进 status/setup
    const status = await req("GET", "/api/v1/admin/mfa/status", TOK_ADMIN);
    expect(status.status).toBe(200);
    expect(await body(status)).toEqual({
      enrolled: false,
      confirmed: false,
      session_verified: false,
    });
  });
});

// ---------------- bootstrap ----------------

describe("POST /admin/bootstrap（首次创建管理员）", () => {
  it("未配置 ADMIN_BOOTSTRAP_CODE → 503 bootstrap_not_configured", async () => {
    ctx.env.ADMIN_BOOTSTRAP_CODE = undefined;
    const res = await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: "target-06a@example.com",
    });
    expect(res.status).toBe(503);
    expect((await body(res)).error_code).toBe("bootstrap_not_configured");
  });

  it("错误 code → 403 bootstrap_code_invalid；不建角色不落审计", async () => {
    const res = await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: "wrong-code-value",
      email: "target-06a@example.com",
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error_code).toBe("bootstrap_code_invalid");
    expect(
      ctx.priv
        .prepare("SELECT * FROM admin_roles WHERE user_id = ?")
        .all(TARGET),
    ).toEqual([]);
    expect(auditRows("admin.bootstrap")).toEqual([]);
  });

  it("正确 code + 不存在邮箱 → 404 bootstrap_target_not_found", async () => {
    const res = await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: "ghost-06a@example.com",
    });
    expect(res.status).toBe(404);
    expect((await body(res)).error_code).toBe("bootstrap_target_not_found");
  });

  it("正确 code → 201 建 admin 角色 + 审计；重复调用幂等 200 不重复审计", async () => {
    const first = await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: "  Target-06a@Example.com ", // 规范化小写去空格
    });
    expect(first.status).toBe(201);
    const created = await body(first);
    expect(created.created).toBe(true);
    expect(String(created.notice)).toContain("撤销");

    const role = ctx.priv
      .prepare("SELECT * FROM admin_roles WHERE user_id = ?")
      .get(TARGET) as Record<string, unknown> | undefined;
    expect(role?.role).toBe("admin");
    expect(role?.created_by).toBe("bootstrap");
    expect(auditRows("admin.bootstrap")).toHaveLength(1);

    const again = await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: "target-06a@example.com",
    });
    expect(again.status).toBe(200);
    expect((await body(again)).created).toBe(false);
    expect(auditRows("admin.bootstrap")).toHaveLength(1);
  });

  it("bootstrap 后目标用户已有角色：可进 mfa/setup，但业务端点仍 403 mfa_required", async () => {
    const res = await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: "target-06a@example.com",
    });
    expect(res.status).toBe(201);

    const setup = await req("POST", "/api/v1/admin/mfa/setup", TOK_TARGET, {});
    expect(setup.status).toBe(200);
    const blocked = await req("GET", "/api/v1/admin/sources", TOK_TARGET);
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error_code).toBe("mfa_required");
  });
});

// ---------------- MFA 流程 ----------------

describe("管理员 TOTP MFA（setup → verify → disable）", () => {
  it("verify 未绑定 → 403 mfa_not_enrolled", async () => {
    const res = await req("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code: "123456",
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error_code).toBe("mfa_not_enrolled");
  });

  it("setup 返回32字符 secret + otpauth URI，并落审计", async () => {
    const res = await req("POST", "/api/v1/admin/mfa/setup", TOK_ADMIN, {});
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(String(data.secret)).toMatch(/^[A-Z2-7]{32}$/u);
    expect(String(data.otpauth_uri)).toContain(`secret=${String(data.secret)}`);
    expect(auditRows("admin.mfa.setup")).toHaveLength(1);
  });

  it("错码 → 400 mfa_invalid_code；格式非法 → 400 validation_failed", async () => {
    const code = await setupAndCode(TOK_ADMIN);
    const wrong = code.startsWith("0")
      ? `1${code.slice(1)}`
      : `0${code.slice(1)}`;
    const bad = await req("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code: wrong,
    });
    expect(bad.status).toBe(400);
    expect((await body(bad)).error_code).toBe("mfa_invalid_code");

    const malformed = await req("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code: "abcdef",
    });
    expect(malformed.status).toBe(400);
    expect((await body(malformed)).error_code).toBe("validation_failed");
  });

  it("正确码 → 200 会话标记；同码重放 → 400；status 反映三态", async () => {
    const code = await setupAndCode(TOK_ADMIN);
    const ok = await req("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code,
    });
    expect(ok.status).toBe(200);
    expect(await body(ok)).toEqual({
      verified: true,
      session_verified: true,
    });

    const replay = await req("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code,
    });
    expect(replay.status).toBe(400);
    expect((await body(replay)).error_code).toBe("mfa_invalid_code");

    const status = await req("GET", "/api/v1/admin/mfa/status", TOK_ADMIN);
    expect(await body(status)).toEqual({
      enrolled: true,
      confirmed: true,
      session_verified: true,
    });
    expect(auditRows("admin.mfa.verify")).toHaveLength(1);
  });

  it("已确认绑定后再 setup → 409 mfa_conflict", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req("POST", "/api/v1/admin/mfa/setup", TOK_ADMIN, {});
    expect(res.status).toBe(409);
    expect((await body(res)).error_code).toBe("mfa_conflict");
  });

  it("同用户新登录会话需重新验证（session 级标记）", async () => {
    await enableMfa(TOK_ADMIN);
    const TOK2 = "tok-admin-06a-session2";
    ctx.priv
      .prepare(
        `INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, datetime('now', '+1 day'))`,
      )
      .run(`sess_${ADMIN}_b`, ADMIN, await sha256Hex(TOK2));
    const res = await req("GET", "/api/v1/admin/sources", TOK2);
    expect(res.status).toBe(403);
    expect((await body(res)).error_code).toBe("mfa_required");
  });
});

describe("POST /admin/mfa/disable（MFA + body code 双确认）", () => {
  it("未过 MFA 的会话 → 403 mfa_required；错码 → 400", async () => {
    await enableMfa(TOK_ADMIN);
    // 同用户第二会话（未过 MFA）
    const TOK2 = "tok-admin-06a-dis";
    ctx.priv
      .prepare(
        `INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, datetime('now', '+1 day'))`,
      )
      .run(`sess_${ADMIN}_dis`, ADMIN, await sha256Hex(TOK2));
    const blocked = await req("POST", "/api/v1/admin/mfa/disable", TOK2, {
      code: "123456",
    });
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error_code).toBe("mfa_required");

    const wrong = await req("POST", "/api/v1/admin/mfa/disable", TOK_ADMIN, {
      code: "000000",
    });
    expect(wrong.status).toBe(400);
    expect((await body(wrong)).error_code).toBe("mfa_invalid_code");
  });

  it("正确码 → 解绑并清除全部会话标记 + 审计；业务端点重新 403", async () => {
    const code = await setupAndCode(TOK_ADMIN);
    await req("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, { code });
    const nextCode = await generate(
      (
        ctx.priv
          .prepare(
            "SELECT secret_base32 FROM admin_mfa_secrets WHERE user_id = ?",
          )
          .get(ADMIN) as { secret_base32: string }
      ).secret_base32,
      Date.now() + 30000, // 下一时间步（verify 窗口 ±1 可验，且 step > 已用步进）
    );
    const res = await req("POST", "/api/v1/admin/mfa/disable", TOK_ADMIN, {
      code: nextCode,
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ disabled: true });

    expect(
      ctx.priv
        .prepare("SELECT * FROM admin_mfa_secrets WHERE user_id = ?")
        .all(ADMIN),
    ).toEqual([]);
    expect(
      ctx.priv
        .prepare("SELECT * FROM admin_mfa_sessions WHERE user_id = ?")
        .all(ADMIN),
    ).toEqual([]);
    expect(auditRows("admin.mfa.disable")).toHaveLength(1);

    const blocked = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error_code).toBe("mfa_required");
  });
});

// ---------------- GET /admin/audit ----------------

describe("GET /admin/audit（审计查询：分页 + 筛选）", () => {
  it("无 MFA → 403 mfa_required；普通用户 → 403 admin_required", async () => {
    const blocked = await req("GET", "/api/v1/admin/audit", TOK_ADMIN);
    expect(blocked.status).toBe(403);
    expect((await body(blocked)).error_code).toBe("mfa_required");
    const plain = await req("GET", "/api/v1/admin/audit", TOK_USER);
    expect(plain.status).toBe(403);
    expect((await body(plain)).error_code).toBe("admin_required");
  });

  it("分页与筛选：total/limit/offset、action 精确命中、limit 上限钳制 200", async () => {
    await enableMfa(TOK_ADMIN);
    // 造多条审计：bootstrap 目标用户 + mfa setup/verify 已在流程中产生
    await req("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: "target-06a@example.com",
    });

    const all = await req("GET", "/api/v1/admin/audit", TOK_ADMIN);
    expect(all.status).toBe(200);
    const list = await body(all);
    expect(Number(list.total)).toBeGreaterThanOrEqual(3);
    expect(Number(list.limit)).toBe(50);
    expect(Number(list.offset)).toBe(0);
    expect(Array.isArray(list.items)).toBe(true);

    const paged = await req(
      "GET",
      "/api/v1/admin/audit?limit=1&offset=1",
      TOK_ADMIN,
    );
    const page = await body(paged);
    expect(page.limit).toBe(1);
    expect(page.offset).toBe(1);
    expect(page.items).toHaveLength(1);

    const capped = await req(
      "GET",
      "/api/v1/admin/audit?limit=9999",
      TOK_ADMIN,
    );
    expect((await body(capped)).limit).toBe(200);

    const filtered = await req(
      "GET",
      "/api/v1/admin/audit?action=admin.mfa.verify",
      TOK_ADMIN,
    );
    const hits = await body(filtered);
    expect(Number(hits.total)).toBe(1);
    const row = (hits.items as Array<Record<string, unknown>>)[0];
    expect(row?.action).toBe("admin.mfa.verify");
    expect(row?.actor_user_id).toBe(ADMIN);

    const empty = await req(
      "GET",
      "/api/v1/admin/audit?action=action.does.not.exist",
      TOK_ADMIN,
    );
    expect((await body(empty)).total).toBe(0);
  });

  it("超长筛选值 → 400 validation_failed", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req(
      "GET",
      `/api/v1/admin/audit?action=${"a".repeat(65)}`,
      TOK_ADMIN,
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error_code).toBe("validation_failed");
  });
});

// ---------------- 04A 漏写补审计（spec R5） ----------------

describe("敏感操作审计补缺（source.create / source.update）", () => {
  it("登记来源与 PATCH 元数据均落 audit_logs", async () => {
    await enableMfa(TOK_ADMIN);
    const created = await req("POST", "/api/v1/admin/sources", TOK_ADMIN, {
      source_id: "src_audit_06a",
      name: "TEST-审计来源",
      source_type: "api",
      official_url: "https://example.com",
      data_scope: "全市小区挂牌价",
      display_scope: "仅站内展示",
    });
    expect(created.status).toBe(201);
    expect(auditRows("source.create")).toHaveLength(1);

    const updated = await req(
      "PATCH",
      "/api/v1/admin/sources/src_audit_06a",
      TOK_ADMIN,
      { display_scope: "站内展示+归因" },
    );
    expect(updated.status).toBe(200);
    expect(auditRows("source.update")).toHaveLength(1);
    const row = auditRows("source.update")[0];
    expect(String(row?.reason)).toContain("display_scope");
    expect(row?.actor_user_id).toBe(ADMIN);
  });
});
