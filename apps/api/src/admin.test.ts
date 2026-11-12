// TASK-04A：管理端数据源登记与审批验收（PRD 任务行 1280–1286 / §10.5 / §5.2 状态机 / §5.3 审核清单）
// 覆盖：管理员角色门禁（401/403）、登记与 PATCH 边界、审批证据四写、状态机 409、
//       coverage 范围收敛、suspend 同步与审计、公开来源页只暴露公开字段。
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

const TOK_ADMIN = "tok-admin-04a";
const TOK_USER = "tok-user-04a";
const ADMIN = "usr-admin-04a";
const USER = "usr-plain-04a";

const CITY = "TEST-0001";

beforeEach(async () => {
  ctx = createTestEnv();
  app = createApp();
  await seedUser(ctx.priv, ADMIN, "admin-04a@example.com", TOK_ADMIN);
  await seedUser(ctx.priv, USER, "user-04a@example.com", TOK_USER);
  grantAdmin(ADMIN);
  seedCity(CITY, "active");
});

function grantAdmin(userId: string): void {
  ctx.priv
    .prepare(
      "INSERT INTO admin_roles (admin_id, user_id, role) VALUES (?, ?, 'owner')",
    )
    .run(`adm_${userId}`, userId);
}

function seedCity(code: string, status: string): void {
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status) VALUES (?, ?, 'TEST-P', ?)",
    )
    .run(code, `TEST-城市${code}`, status);
}

function seedSource(
  sourceId: string,
  status = "discovered",
  validUntil: string | null = null,
): void {
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, ?, 'api')",
    )
    .run(sourceId, `TEST-来源${sourceId}`);
  ctx.pub
    .prepare(
      "INSERT INTO source_license_state (source_id, status, valid_until) VALUES (?, ?, ?)",
    )
    .run(sourceId, status, validUntil);
}

function seedCoverage(
  sourceId: string,
  cityCode: string,
  level: string,
  authz = "approved_open",
): void {
  ctx.pub
    .prepare(
      `INSERT INTO source_city_coverage
         (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
       VALUES (?, ?, ?, '["community_ask_median_unit"]', ?, datetime('now'))`,
    )
    .run(sourceId, cityCode, level, authz);
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
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    ctx.env,
  );
}

function validApprove(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "approved_open",
    evidence_ref: "contract://test-04a",
    permitted_fields: ["unit_price", "total_price"],
    permitted_purposes: ["personal_watch"],
    frequency: "daily",
    retention_period: "90d",
    coverage: [
      {
        city_code: CITY,
        object_level: "community",
        metric_codes: ["community_ask_median_unit"],
      },
    ],
    ...overrides,
  };
}

function licenseRow(sourceId: string) {
  return ctx.pub
    .prepare(
      "SELECT status, valid_until FROM source_license_state WHERE source_id = ?",
    )
    .get(sourceId) as { status: string; valid_until: string | null };
}

function coverageRows(sourceId: string) {
  return ctx.pub
    .prepare(
      "SELECT city_code, object_level, authorization_status FROM source_city_coverage WHERE source_id = ? ORDER BY city_code",
    )
    .all(sourceId) as Array<{
    city_code: string;
    object_level: string;
    authorization_status: string;
  }>;
}

async function body(res: Response): Promise<Record<string, never>> {
  return (await res.json()) as Record<string, never>;
}

describe("管理员认证门禁（TASK-06A 前的最小 requireAdmin）", () => {
  it("未登录 → 401", async () => {
    const res = await req("GET", "/api/v1/admin/sources");
    expect(res.status).toBe(401);
    expect((await body(res)).error_code).toBe("unauthorized");
  });

  it("普通用户 → 403 admin_required，且拿不到来源列表", async () => {
    const res = await req("GET", "/api/v1/admin/sources", TOK_USER);
    expect(res.status).toBe(403);
    const b = await body(res);
    expect(b.error_code).toBe("admin_required");
    expect("items" in b).toBe(false);
  });

  it("有效 admin_roles 角色 → 200", async () => {
    const res = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    expect(res.status).toBe(200);
    expect((await res.json()) as { count: number }).toMatchObject({ count: 0 });
  });

  it("撤销角色（revoked_at 非空）→ 403", async () => {
    ctx.priv
      .prepare(
        "UPDATE admin_roles SET revoked_at = datetime('now') WHERE user_id = ?",
      )
      .run(ADMIN);
    const res = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    expect(res.status).toBe(403);
  });
});

describe("登记与元数据 PATCH", () => {
  it("登记即 discovered；重复 source_id → 409", async () => {
    const res = await req("POST", "/api/v1/admin/sources", TOK_ADMIN, {
      source_id: "src_test_a",
      name: "TEST-来源甲（虚构）",
      source_type: "api",
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { source: { status: string } };
    expect(b.source.status).toBe("discovered");
    expect(licenseRow("src_test_a").status).toBe("discovered");

    const dup = await req("POST", "/api/v1/admin/sources", TOK_ADMIN, {
      source_id: "src_test_a",
      name: "重复",
      source_type: "api",
    });
    expect(dup.status).toBe(409);
    expect((await body(dup)).error_code).toBe("conflict");
  });

  it("PATCH 携带 status → 400（状态只能走审批/停用端点）", async () => {
    seedSource("src_patch");
    const res = await req(
      "PATCH",
      "/api/v1/admin/sources/src_patch",
      TOK_ADMIN,
      {
        status: "approved_open",
      },
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error_code).toBe("validation_failed");
    expect(licenseRow("src_patch").status).toBe("discovered");
  });

  it("PATCH 改元数据生效；带审批私有字段（evidence_ref）→ 400；未知来源 → 404", async () => {
    seedSource("src_patch2");
    const ok = await req(
      "PATCH",
      "/api/v1/admin/sources/src_patch2",
      TOK_ADMIN,
      {
        name: "TEST-改名（虚构）",
      },
    );
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { source: { name: string } }).source.name,
    ).toBe("TEST-改名（虚构）");

    const ev = await req(
      "PATCH",
      "/api/v1/admin/sources/src_patch2",
      TOK_ADMIN,
      {
        evidence_ref: "contract://x",
      },
    );
    expect(ev.status).toBe(400);

    const missing = await req(
      "PATCH",
      "/api/v1/admin/sources/src_nope",
      TOK_ADMIN,
      {
        name: "x",
      },
    );
    expect(missing.status).toBe(404);
  });
});

describe("审批（POST /admin/sources/:id/approve）", () => {
  it("证据五件套+coverage 任一缺失 → 400，状态与审批记录不变", async () => {
    seedSource("src_pending", "pending_review");
    const noEvidence = validApprove({ evidence_ref: undefined });
    delete (noEvidence as Record<string, unknown>)["evidence_ref"];
    const res = await req(
      "POST",
      "/api/v1/admin/sources/src_pending/approve",
      TOK_ADMIN,
      noEvidence,
    );
    expect(res.status).toBe(400);
    const b = (await res.json()) as {
      error_code: string;
      details: Array<{ field: string; message: string }>;
    };
    expect(b.error_code).toBe("validation_failed");
    expect(b.details.some((d) => d.message.includes("evidence_ref"))).toBe(
      true,
    );
    expect(licenseRow("src_pending").status).toBe("pending_review");
    expect(
      (
        ctx.priv
          .prepare("SELECT COUNT(*) AS n FROM source_approvals")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });

  it("审批成功四写：approvals（含证据）+ 状态 + coverage + 审计", async () => {
    seedSource("src_ok", "pending_review");
    const res = await req(
      "POST",
      "/api/v1/admin/sources/src_ok/approve",
      TOK_ADMIN,
      validApprove({ valid_until: "2027-12-31" }),
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as { source: { status: string } };
    expect(b.source.status).toBe("approved_open");

    // 1) 状态与到期日
    expect(licenseRow("src_ok")).toMatchObject({
      status: "approved_open",
      valid_until: "2027-12-31",
    });
    // 2) coverage 落地
    expect(coverageRows("src_ok")).toEqual([
      {
        city_code: CITY,
        object_level: "community",
        authorization_status: "approved_open",
      },
    ]);
    // 3) 审批记录（append-only）含证据与范围
    const approval = ctx.priv
      .prepare(
        "SELECT approver_user_id, evidence_ref, status_after, allowed_cities_json FROM source_approvals WHERE source_id = ?",
      )
      .get("src_ok") as {
      approver_user_id: string;
      evidence_ref: string;
      status_after: string;
      allowed_cities_json: string;
    };
    expect(approval).toMatchObject({
      approver_user_id: ADMIN,
      evidence_ref: "contract://test-04a",
      status_after: "approved_open",
    });
    expect(JSON.parse(approval.allowed_cities_json)[0].city_code).toBe(CITY);
    // 4) 审计
    const audit = ctx.priv
      .prepare(
        "SELECT action, actor_user_id FROM audit_logs WHERE resource_id = ? ORDER BY created_at DESC",
      )
      .get("src_ok") as { action: string; actor_user_id: string };
    expect(audit).toMatchObject({
      action: "source.approve",
      actor_user_id: ADMIN,
    });
  });

  it("coverage 中 city_code 不存在 → 404，且不产生任何写入", async () => {
    seedSource("src_badcity");
    const res = await req(
      "POST",
      "/api/v1/admin/sources/src_badcity/approve",
      TOK_ADMIN,
      validApprove({
        coverage: [
          {
            city_code: "9999-NOPE",
            object_level: "community",
            metric_codes: ["community_ask_median_unit"],
          },
        ],
      }),
    );
    expect(res.status).toBe(404);
    expect(licenseRow("src_badcity").status).toBe("discovered");
    expect(coverageRows("src_badcity")).toEqual([]);
  });

  it("coverage 空数组（minItems）与元素缺字段（items 递归）→ 400", async () => {
    seedSource("src_items");
    const emptyCov = await req(
      "POST",
      "/api/v1/admin/sources/src_items/approve",
      TOK_ADMIN,
      validApprove({ coverage: [] }),
    );
    expect(emptyCov.status).toBe(400);
    expect(
      (((await emptyCov.json()) as { details: Array<{ message: string }> })
        .details ?? [])[0]?.message,
    ).toContain("至少需要 1 个元素");

    const badElem = await req(
      "POST",
      "/api/v1/admin/sources/src_items/approve",
      TOK_ADMIN,
      validApprove({
        coverage: [{ city_code: CITY, object_level: "community" }],
      }),
    );
    expect(badElem.status).toBe(400);
    expect(
      (((await badElem.json()) as { details: Array<{ message: string }> })
        .details ?? [])[0]?.message,
    ).toContain("缺少必需字段 metric_codes");
    expect(licenseRow("src_items").status).toBe("discovered");
  });

  it("blocked 来源不可审批 → 409；approved 重复审批 → 409（须先停用）", async () => {
    seedSource("src_blocked", "blocked");
    const r1 = await req(
      "POST",
      "/api/v1/admin/sources/src_blocked/approve",
      TOK_ADMIN,
      validApprove(),
    );
    expect(r1.status).toBe(409);
    expect(licenseRow("src_blocked").status).toBe("blocked");

    seedSource("src_approved", "approved_open");
    const r2 = await req(
      "POST",
      "/api/v1/admin/sources/src_approved/approve",
      TOK_ADMIN,
      validApprove(),
    );
    expect(r2.status).toBe(409);

    // 先 suspend 再审批（显式留痕路径）→ 通过
    const sus = await req(
      "POST",
      "/api/v1/admin/sources/src_approved/suspend",
      TOK_ADMIN,
      { reason: "授权变更重审" },
    );
    expect(sus.status).toBe(200);
    const again = await req(
      "POST",
      "/api/v1/admin/sources/src_approved/approve",
      TOK_ADMIN,
      validApprove(),
    );
    expect(again.status).toBe(200);
    expect(licenseRow("src_approved").status).toBe("approved_open");
  });

  it("审批范围收敛：不在本次 coverage 的既有覆盖行降为 suspended", async () => {
    seedSource("src_scope", "pending_review");
    seedCoverage("src_scope", CITY, "listing"); // 既有 listing 覆盖
    const res = await req(
      "POST",
      "/api/v1/admin/sources/src_scope/approve",
      TOK_ADMIN,
      validApprove({
        coverage: [
          {
            city_code: CITY,
            object_level: "community",
            metric_codes: ["community_ask_median_unit"],
          },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const rows = coverageRows("src_scope");
    expect(rows).toEqual([
      {
        city_code: CITY,
        object_level: "community",
        authorization_status: "approved_open",
      },
      {
        city_code: CITY,
        object_level: "listing",
        authorization_status: "suspended",
      },
    ]);
  });
});

describe("停用（POST /admin/sources/:id/suspend）", () => {
  it("reason 必填；成功后状态与 coverage 同步 suspended 并写审计", async () => {
    seedSource("src_sus", "approved_open");
    seedCoverage("src_sus", CITY, "community");
    seedCoverage("src_sus", CITY, "listing");

    const bad = await req(
      "POST",
      "/api/v1/admin/sources/src_sus/suspend",
      TOK_ADMIN,
      {},
    );
    expect(bad.status).toBe(400);

    const res = await req(
      "POST",
      "/api/v1/admin/sources/src_sus/suspend",
      TOK_ADMIN,
      { reason: "授权撤销" },
    );
    expect(res.status).toBe(200);
    expect(licenseRow("src_sus").status).toBe("suspended");
    expect(
      coverageRows("src_sus").every(
        (r) => r.authorization_status === "suspended",
      ),
    ).toBe(true);
    const audit = ctx.priv
      .prepare(
        "SELECT action, reason FROM audit_logs WHERE resource_id = ? AND action = 'source.suspend'",
      )
      .get("src_sus") as { action: string; reason: string };
    expect(audit.reason).toBe("授权撤销");
  });

  it("未知来源 suspend → 404", async () => {
    const res = await req(
      "POST",
      "/api/v1/admin/sources/src_nope/suspend",
      TOK_ADMIN,
      {
        reason: "x",
      },
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/sources 列表", () => {
  it("返回状态/覆盖/审批计数，并对过期授权惰性自动 suspend", async () => {
    seedSource("src_list", "approved_open", "2020-01-01"); // 已过期
    seedCoverage("src_list", CITY, "community");
    const res = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      items: Array<{
        source_id: string;
        status: string;
        is_expired: boolean;
        coverage: unknown[];
        approval_count: number;
      }>;
    };
    expect(b.items).toHaveLength(1);
    expect(b.items[0]).toMatchObject({
      source_id: "src_list",
      status: "suspended", // 惰性过期已写回
      is_expired: true,
      approval_count: 0,
    });
    expect(b.items[0]!.coverage).toHaveLength(1);
    expect(licenseRow("src_list").status).toBe("suspended");
    const audit = ctx.priv
      .prepare("SELECT action, reason FROM audit_logs WHERE resource_id = ?")
      .get("src_list") as { action: string; reason: string };
    expect(audit).toMatchObject({
      action: "source.auto_suspend",
      reason: "license_expired",
    });
    // coverage 同步
    expect(coverageRows("src_list")[0]!.authorization_status).toBe("suspended");
  });
});

describe("公开来源页（GET /public/methodology/sources）", () => {
  it("附 license_status/license_valid_until，且不含审批私有字段", async () => {
    seedSource("src_pub", "approved_licensed", "2027-06-30");
    const res = await req("GET", "/api/v1/public/methodology/sources");
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const item = b.items.find((i) => i.source_id === "src_pub");
    expect(item).toMatchObject({
      license_status: "approved_licensed",
      license_valid_until: "2027-06-30",
    });
    expect("evidence_ref" in item!).toBe(false);
    expect("approver_user_id" in item!).toBe(false);
    expect("permitted_fields" in item!).toBe(false);
  });

  it("无 license 行的来源按 discovered 展示", async () => {
    ctx.pub
      .prepare(
        "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_legacy', 'TEST-旧来源', 'manual')",
      )
      .run();
    const res = await req("GET", "/api/v1/public/methodology/sources");
    const b = (await res.json()) as { items: Array<Record<string, unknown>> };
    const item = b.items.find((i) => i.source_id === "src_legacy");
    expect(item).toMatchObject({ license_status: "discovered" });
    expect(item!["license_valid_until"]).toBeNull();
  });
});
