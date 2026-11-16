// TASK-06C：数据源管理后台 API 验收（PRD 任务行 1362–1368 / spec R1/R2）
// 覆盖：GET /admin/sources/:id/approvals（门禁/404/append-only 历史全保留/倒序/字段解析）、
//       GET /admin/sources 合并 health_status/last_success_at（最新报告 + 最近成功任务）。
// 验收条款回归：未审批不能启用 / 暂停阻止 connector 由 admin.test.ts（04A）与
//       internal.test.ts（04B source-gate）既有断言覆盖，本文件不重复。
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

const TOK_ADMIN = "tok-admin-06c";
const TOK_USER = "tok-user-06c";
const ADMIN = "usr-admin-06c";
const USER = "usr-plain-06c";
const CITY = "TEST-0001";
const SRC = "test_src_06c";

beforeEach(async () => {
  ctx = createTestEnv();
  app = createApp();
  await seedUser(ctx.priv, ADMIN, "admin-06c@example.com", TOK_ADMIN);
  await seedUser(ctx.priv, USER, "user-06c@example.com", TOK_USER);
  ctx.priv
    .prepare(
      "INSERT INTO admin_roles (admin_id, user_id, role) VALUES (?, ?, 'owner')",
    )
    .run(`adm_${ADMIN}`, ADMIN);
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status) VALUES (?, ?, 'TEST-P', 'active')",
    )
    .run(CITY, `TEST-城市${CITY}`);
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, ?, 'api')",
    )
    .run(SRC, `TEST-来源${SRC}`);
  ctx.pub
    .prepare(
      "INSERT INTO source_license_state (source_id, status) VALUES (?, 'discovered')",
    )
    .run(SRC);
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
      body: payload === undefined ? undefined : JSON.stringify(payload),
    },
    ctx.env,
  );
}

async function enableMfa(token: string): Promise<void> {
  const setup = await req("POST", "/api/v1/admin/mfa/setup", token, {});
  const { secret } = (await setup.json()) as { secret: string };
  const verified = await req("POST", "/api/v1/admin/mfa/verify", token, {
    code: await generate(secret),
  });
  expect(verified.status).toBe(200);
}

/** 走真实 approve 端点写入审批记录（不手插，保证列填充与生产一致） */
async function approve(
  token: string,
  status: "approved_open" | "approved_licensed",
  evidence: string,
): Promise<void> {
  const res = await req("POST", `/api/v1/admin/sources/${SRC}/approve`, token, {
    status,
    evidence_ref: evidence,
    permitted_fields: ["community_ask_median_unit"],
    permitted_purposes: ["display"],
    frequency: "daily",
    retention_period: "180d",
    coverage: [
      {
        city_code: CITY,
        object_level: "community",
        metric_codes: ["community_ask_median_unit"],
      },
    ],
    valid_until: null,
    note: `06C 测试审批 ${evidence}`,
  });
  expect(res.status).toBe(200);
}

// ---------------- R1：审批历史 ----------------

describe("GET /admin/sources/:id/approvals", () => {
  it("门禁：匿名 401 / 普通 403 admin_required / 未 MFA 403 mfa_required", async () => {
    const anon = await req("GET", `/api/v1/admin/sources/${SRC}/approvals`);
    expect(anon.status).toBe(401);

    const plain = await req(
      "GET",
      `/api/v1/admin/sources/${SRC}/approvals`,
      TOK_USER,
    );
    expect(plain.status).toBe(403);
    expect(((await plain.json()) as { error_code: string }).error_code).toBe(
      "admin_required",
    );

    const noMfa = await req(
      "GET",
      `/api/v1/admin/sources/${SRC}/approvals`,
      TOK_ADMIN,
    );
    expect(noMfa.status).toBe(403);
    expect(((await noMfa.json()) as { error_code: string }).error_code).toBe(
      "mfa_required",
    );
  });

  it("来源不存在 404；无审批历史空列表", async () => {
    await enableMfa(TOK_ADMIN);
    const missing = await req(
      "GET",
      "/api/v1/admin/sources/test_src_nonexist/approvals",
      TOK_ADMIN,
    );
    expect(missing.status).toBe(404);

    const empty = await req(
      "GET",
      `/api/v1/admin/sources/${SRC}/approvals`,
      TOK_ADMIN,
    );
    expect(empty.status).toBe(200);
    const b = (await empty.json()) as { items: unknown[]; count: number };
    expect(b).toEqual({ items: [], count: 0 });
  });

  it("两次审批历史全保留（不可无痕修改）：倒序 + 字段完整 + JSON 解析", async () => {
    await enableMfa(TOK_ADMIN);
    await approve(
      TOK_ADMIN,
      "approved_licensed",
      "证据一：授权邮件 2026-11-01",
    );
    // 暂停后重新审批（状态机允许 suspended → approve）
    const susp = await req(
      "POST",
      `/api/v1/admin/sources/${SRC}/suspend`,
      TOK_ADMIN,
      { reason: "06C 测试暂停" },
    );
    expect(susp.status).toBe(200);
    await approve(TOK_ADMIN, "approved_open", "证据二：开放许可页面存档");

    const res = await req(
      "GET",
      `/api/v1/admin/sources/${SRC}/approvals`,
      TOK_ADMIN,
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      count: number;
    };
    // 两条审批全部保留（suspend 不删记录——append-only）
    expect(b.count).toBe(2);
    expect(b.items).toHaveLength(2);

    // created_at DESC（同秒内 UUID 排序不确定，只断言非增 + 集合完整）
    expect(
      String(b.items[0]!.created_at) >= String(b.items[1]!.created_at),
    ).toBe(true);
    expect(b.items.map((i) => i.status_after).sort()).toEqual([
      "approved_licensed",
      "approved_open",
    ]);
    const open = b.items.find((i) => i.status_after === "approved_open")!;
    expect(open.evidence_ref).toBe("证据二：开放许可页面存档");

    for (const item of b.items) {
      expect(item.action).toBe("approve");
      expect(item.approver_user_id).toBe(ADMIN);
      expect(item.permitted_fields).toEqual(["community_ask_median_unit"]);
      expect(item.permitted_purposes).toEqual(["display"]);
      expect(item.allowed_cities).toEqual([
        {
          city_code: CITY,
          object_level: "community",
          metric_codes: ["community_ask_median_unit"],
        },
      ]);
      expect(item.frequency).toBe("daily");
      expect(item.retention_period).toBe("180d");
      expect(item.valid_until).toBeNull();
      expect(String(item.note)).toContain("06C 测试审批");
      expect(typeof item.created_at).toBe("string");
    }
  });

  it("只读端点不写审计（历史查询前后 audit_logs 行数不变）", async () => {
    await enableMfa(TOK_ADMIN);
    await approve(TOK_ADMIN, "approved_open", "证据零");
    const before = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM audit_logs")
      .get() as unknown as { n: number };
    const res = await req(
      "GET",
      `/api/v1/admin/sources/${SRC}/approvals`,
      TOK_ADMIN,
    );
    expect(res.status).toBe(200);
    const after = ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM audit_logs")
      .get() as unknown as { n: number };
    expect(after.n).toBe(before.n);
  });
});

// ---------------- R2：列表合并 health ----------------

describe("GET /admin/sources health 摘要", () => {
  function seedHealth(
    reportId: string,
    status: string,
    checkedAt: string,
    sourceId = SRC,
  ): void {
    ctx.priv
      .prepare(
        `INSERT INTO source_health_reports (report_id, source_id, status, checked_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(reportId, sourceId, status, checkedAt);
  }

  function seedJob(
    jobId: string,
    status: string,
    finishedAt: string | null,
    sourceId = SRC,
  ): void {
    ctx.priv
      .prepare(
        `INSERT INTO ingest_jobs (job_id, source_id, city_code, status, finished_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(jobId, sourceId, CITY, status, finishedAt);
  }

  it("无记录 → health_status=unknown / last_success_at=null", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    const b = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const item = b.items.find((i) => i.source_id === SRC)!;
    expect(item.health_status).toBe("unknown");
    expect(item.last_success_at).toBeNull();
  });

  it("取最新健康报告与最近成功任务（failed/running 不计入）", async () => {
    await enableMfa(TOK_ADMIN);
    seedHealth("h1", "ok", "2026-11-14 08:00:00");
    seedHealth("h2", "down", "2026-11-15 08:00:00"); // 最新
    seedHealth("h3", "degraded", "2026-11-13 08:00:00");
    seedJob("j1", "succeeded", "2026-11-14 09:00:00");
    seedJob("j2", "succeeded", "2026-11-15 09:30:00"); // 最近成功
    seedJob("j3", "failed", "2026-11-16 09:00:00"); // 不计入
    seedJob("j4", "running", null); // 不计入

    const res = await req("GET", "/api/v1/admin/sources", TOK_ADMIN);
    const b = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const item = b.items.find((i) => i.source_id === SRC)!;
    expect(item.health_status).toBe("down");
    expect(item.last_success_at).toBe("2026-11-15 09:30:00");
  });

  it("单来源响应（approve 返回）同样携带 health 字段", async () => {
    await enableMfa(TOK_ADMIN);
    seedHealth("h1", "ok", "2026-11-15 08:00:00");
    seedJob("j1", "succeeded", "2026-11-15 09:00:00");
    const res = await req(
      "POST",
      `/api/v1/admin/sources/${SRC}/approve`,
      TOK_ADMIN,
      {
        status: "approved_open",
        evidence_ref: "证据三：开放数据声明",
        permitted_fields: ["community_ask_median_unit"],
        permitted_purposes: ["display"],
        frequency: "daily",
        retention_period: "180d",
        coverage: [
          {
            city_code: CITY,
            object_level: "community",
            metric_codes: ["community_ask_median_unit"],
          },
        ],
      },
    );
    expect(res.status).toBe(200);
    const { source } = (await res.json()) as {
      source: Record<string, unknown>;
    };
    expect(source.health_status).toBe("ok");
    expect(source.last_success_at).toBe("2026-11-15 09:00:00");
  });
});
