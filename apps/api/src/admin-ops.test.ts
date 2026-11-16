// TASK-06D：任务和质量后台 API 验收（PRD 任务行 1368–1374 / spec R2–R5/R8）
// 覆盖：门禁矩阵、GET /admin/jobs（筛选/搜索/排序/分页/summary + §8.6 全字段）、
//       GET /admin/quality/issues（三类聚合 + locator 定位要素非空——验收一）、
//       overview ops 块（四指标卡）、internal 新字段落库与向后兼容、
//       重跑幂等实证（拍板 3：duplicate 不重写 / finish 不改写 / 同观测不重复行——验收二）。
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

const SECRET = "test-ingest-secret-06d";
const TOK_ADMIN = "tok-admin-06d";
const TOK_USER = "tok-user-06d";
const ADMIN = "usr-admin-06d";
const USER = "usr-plain-06d";
const CITY = "TEST-0001";
const SRC = "src_official";
const STAT_DATE = new Date(Date.now() - 86_400_000 + 8 * 3600_000)
  .toISOString()
  .slice(0, 10);

beforeEach(async () => {
  ctx = createTestEnv();
  app = createApp();
  ctx.env.INGEST_HMAC_SECRET = SECRET;
  await seedUser(ctx.priv, ADMIN, "admin-06d@example.com", TOK_ADMIN);
  await seedUser(ctx.priv, USER, "plain-06d@example.com", TOK_USER);
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
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, 'TEST-来源', 'open_data')",
    )
    .run(SRC);
  ctx.pub
    .prepare(
      "INSERT INTO source_license_state (source_id, status) VALUES (?, 'approved_open')",
    )
    .run(SRC);
  ctx.pub
    .prepare(
      `INSERT INTO source_city_coverage
         (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
       VALUES (?, ?, 'community', '["community_ask_median_unit","listing_ask_unit"]', 'approved_open', datetime('now'))`,
    )
    .run(SRC, CITY);
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

// ---------------- internal 签名链（与 04A/04B 同口径） ----------------

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let nonceSeq = 0;
async function postSigned(
  path: string,
  payload: unknown,
): Promise<{ res: Response; nonce: string; raw: string }> {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  nonceSeq += 1;
  const nonce = `nonce-06d-${String(nonceSeq).padStart(3, "0")}`;
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ingest-Timestamp": ts,
        "X-Ingest-Nonce": nonce,
        "X-Ingest-Signature": await hmacHex(SECRET, `${ts}.${nonce}.${raw}`),
      },
      body: raw,
    },
    ctx.env,
  );
  return { res, nonce, raw };
}

async function jobStart(
  jobId: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const { res } = await postSigned("/api/v1/internal/jobs/start", {
    job_id: jobId,
    source_id: SRC,
    city_code: CITY,
    object_level: "community",
    ...extra,
  });
  return res;
}

async function jobFinish(
  jobId: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const { res } = await postSigned(`/api/v1/internal/jobs/${jobId}/finish`, {
    status: "succeeded",
    ...extra,
  });
  return res;
}

function obsPayload(
  batchId: string,
  observations: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    batch_id: batchId,
    source_id: SRC,
    city_code: CITY,
    object_level: "community",
    observed_count: observations.length,
    observations,
  };
}

function obs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object_id: "cmt_06d_01",
    property_type: "resale",
    price_type: "listing_ask",
    metric_code: "listing_ask_unit",
    price_total_fen: 300000000,
    unit_price_yuan_sqm: 30000,
    area_sqm: 100,
    sample_count: 1,
    stat_date: STAT_DATE,
    quality_status: "valid",
    connector_version: "radar-connector/0.6.0",
    ...overrides,
  };
}

function jobRow(jobId: string): Record<string, unknown> {
  return ctx.priv
    .prepare("SELECT * FROM ingest_jobs WHERE job_id = ?")
    .get(jobId) as unknown as Record<string, unknown>;
}

function obsRowCount(): number {
  return (
    ctx.pub.prepare("SELECT COUNT(*) AS n FROM price_observations").get() as {
      n: number;
    }
  ).n;
}

// ---------------- 门禁矩阵 ----------------

describe("06D 门禁矩阵", () => {
  for (const path of ["/api/v1/admin/jobs", "/api/v1/admin/quality/issues"]) {
    it(`${path}：匿名 401 / 普通 403 admin_required / 未 MFA 403 mfa_required`, async () => {
      expect((await req("GET", path)).status).toBe(401);

      const plain = await req("GET", path, TOK_USER);
      expect(plain.status).toBe(403);
      expect(((await plain.json()) as { error_code: string }).error_code).toBe(
        "admin_required",
      );

      const noMfa = await req("GET", path, TOK_ADMIN);
      expect(noMfa.status).toBe(403);
      expect(((await noMfa.json()) as { error_code: string }).error_code).toBe(
        "mfa_required",
      );
    });
  }
});

// ---------------- R2：internal 新字段落库与向后兼容 ----------------

describe("internal jobs 新字段（§8.6 补齐）", () => {
  it("start 带 run_type/connector_version/workflow_url 落库；不带则 NULL（兼容 04B 载荷）", async () => {
    expect(
      (
        await jobStart("j_06d_full", {
          run_type: "scheduled",
          connector_version: "radar-connector/0.6.0",
          workflow_url: "https://github.com/o/r/actions/runs/1",
        })
      ).status,
    ).toBe(202);
    expect((await jobStart("j_06d_legacy")).status).toBe(202);

    const full = jobRow("j_06d_full");
    expect(full.run_type).toBe("scheduled");
    expect(full.connector_version).toBe("radar-connector/0.6.0");
    expect(full.workflow_url).toBe("https://github.com/o/r/actions/runs/1");
    const legacy = jobRow("j_06d_legacy");
    expect(legacy.run_type).toBeNull();
    expect(legacy.connector_version).toBeNull();
    expect(legacy.workflow_url).toBeNull();
  });

  it("finish 带 records_*/communities_covered 落库", async () => {
    await jobStart("j_06d_fin");
    expect(
      (
        await jobFinish("j_06d_fin", {
          records_fetched: 120,
          records_accepted: 100,
          records_rejected: 20,
          communities_covered: 35,
        })
      ).status,
    ).toBe(202);
    const row = jobRow("j_06d_fin");
    expect(row.records_fetched).toBe(120);
    expect(row.records_accepted).toBe(100);
    expect(row.records_rejected).toBe(20);
    expect(row.communities_covered).toBe(35);
  });

  it("批次观测落 batch_id（验收一定位链）", async () => {
    const { res } = await postSigned(
      "/api/v1/internal/ingest/batch",
      obsPayload("b_06d_loc", [obs()]),
    );
    expect(res.status).toBe(202);
    const row = ctx.pub
      .prepare(
        "SELECT batch_id, connector_version, quality_status FROM price_observations LIMIT 1",
      )
      .get() as unknown as Record<string, unknown>;
    expect(row.batch_id).toBe("b_06d_loc");
    expect(row.connector_version).toBe("radar-connector/0.6.0");
  });
});

// ---------------- 拍板 3：重跑幂等实证 ----------------

describe("重跑幂等保护（验收二）", () => {
  it("同 job_id 重跑 start → 202 duplicate，不新增行", async () => {
    expect((await jobStart("j_06d_dup")).status).toBe(202);
    const again = await jobStart("j_06d_dup");
    expect(again.status).toBe(202);
    expect(((await again.json()) as { status: string }).status).toBe(
      "duplicate",
    );
    expect(
      ctx.priv.prepare("SELECT COUNT(*) AS n FROM ingest_jobs").get(),
    ).toEqual({ n: 1 });
  });

  it("重复 finish 幂等：计数不改写（重跑不污染已留痕数据）", async () => {
    await jobStart("j_06d_fin2");
    await jobFinish("j_06d_fin2", {
      records_fetched: 10,
      records_accepted: 10,
    });
    const retry = await postSigned("/api/v1/internal/jobs/j_06d_fin2/finish", {
      status: "failed",
      error_code: "E_RETRY",
      records_fetched: 999,
    });
    expect(retry.res.status).toBe(202);
    const row = jobRow("j_06d_fin2");
    expect(row.status).toBe("succeeded");
    expect(row.records_fetched).toBe(10);
    expect(row.error_code).toBeNull();
  });

  it("同 batch_id 重提 → 202 duplicate，观测与批次行数不变", async () => {
    const first = await postSigned(
      "/api/v1/internal/ingest/batch",
      obsPayload("b_06d_idem", [obs({ object_id: "cmt_06d_a" })]),
    );
    expect(first.res.status).toBe(202);
    const rowsAfterFirst = obsRowCount();
    // 新 nonce 重放同 batch_id：批次受理幂等
    const retry = await postSigned(
      "/api/v1/internal/ingest/batch",
      obsPayload("b_06d_idem", [obs({ object_id: "cmt_06d_a" })]),
    );
    expect(retry.res.status).toBe(202);
    expect(((await retry.res.json()) as { status: string }).status).toBe(
      "duplicate",
    );
    expect(obsRowCount()).toBe(rowsAfterFirst);
  });

  it("同观测跨批次重跑 → 确定性 ID upsert 不重复行，batch_id 更新", async () => {
    await postSigned(
      "/api/v1/internal/ingest/batch",
      obsPayload("b_06d_r1", [obs({ object_id: "cmt_06d_b" })]),
    );
    const after1 = obsRowCount();
    const second = await postSigned(
      "/api/v1/internal/ingest/batch",
      obsPayload("b_06d_r2", [obs({ object_id: "cmt_06d_b" })]),
    );
    expect(second.res.status).toBe(202);
    expect(obsRowCount()).toBe(after1); // 行数不变：不重复插入价格快照
    const row = ctx.pub
      .prepare("SELECT batch_id FROM price_observations WHERE object_id = ?")
      .get("cmt_06d_b") as unknown as { batch_id: string };
    expect(row.batch_id).toBe("b_06d_r2"); // 归属更新为最新批次
  });
});

// ---------------- R3：GET /admin/jobs ----------------

describe("GET /admin/jobs", () => {
  beforeEach(async () => {
    await enableMfa(TOK_ADMIN);
  });

  async function jobs(params = "") {
    const res = await req("GET", `/api/v1/admin/jobs${params}`, TOK_ADMIN);
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      items: Array<Record<string, unknown>>;
      count: number;
      summary: { jobs_7d: Record<string, number>; success_rate: number | null };
    }>;
  }

  it("空库：items 空、count 0、success_rate null（分母 0）", async () => {
    const b = await jobs();
    expect(b.items).toEqual([]);
    expect(b.count).toBe(0);
    expect(b.summary.success_rate).toBeNull();
  });

  it("§8.6 全字段 + source_name + 筛选/搜索/排序/分页", async () => {
    await jobStart("j_06d_s1", { run_type: "scheduled" });
    await jobFinish("j_06d_s1", { records_fetched: 5, records_accepted: 5 });
    const failStart = await postSigned("/api/v1/internal/jobs/start", {
      job_id: "j_06d_s2",
      source_id: SRC,
      city_code: CITY,
      object_level: "community",
      run_type: "retry",
      connector_version: "radar-connector/0.6.1",
    });
    expect(failStart.res.status).toBe(202);
    const failFinish = await postSigned(
      "/api/v1/internal/jobs/j_06d_s2/finish",
      {
        status: "failed",
        error_code: "HTTP_503",
        note: "上游不可用",
        records_fetched: 0,
      },
    );
    expect(failFinish.res.status).toBe(202);
    // 拉开 started_at（同秒插入会让 asc 断言不确定）
    ctx.priv
      .prepare(
        "UPDATE ingest_jobs SET started_at = '2026-11-15 01:00:00' WHERE job_id = 'j_06d_s1'",
      )
      .run();

    const all = await jobs();
    expect(all.count).toBe(2);
    expect(all.summary.jobs_7d).toEqual({
      succeeded: 1,
      failed: 1,
      running: 0,
    });
    expect(all.summary.success_rate).toBe(0.5);
    const s2 = all.items.find((i) => i.job_id === "j_06d_s2")!;
    expect(s2).toMatchObject({
      source_id: SRC,
      source_name: "TEST-来源",
      city_code: CITY,
      run_type: "retry",
      status: "failed",
      error_code: "HTTP_503",
      note: "上游不可用",
      connector_version: "radar-connector/0.6.1",
      records_fetched: 0,
    });
    expect(s2.finished_at).not.toBeNull();

    const failed = await jobs("?status=failed");
    expect(failed.items.map((i) => i.job_id)).toEqual(["j_06d_s2"]);
    const bySrc = await jobs(`?source_id=${SRC}&limit=1&offset=1`);
    expect(bySrc.count).toBe(2);
    expect(bySrc.items).toHaveLength(1);
    const asc = await jobs("?sort=started_at&order=asc");
    expect(asc.items[0]!.job_id).toBe("j_06d_s1");
    const q = await jobs("?q=j_06d_s2");
    expect(q.items).toHaveLength(1);
    const miss = await jobs("?q=%25wild%25"); // % 转义为字面量，不产生通配
    expect(miss.items).toHaveLength(0);
    const otherCity = await jobs("?city_code=TEST-9999");
    expect(otherCity.items).toHaveLength(0);
  });

  it("非法参数 400：status/sort/order/limit", async () => {
    for (const qs of [
      "?status=bogus",
      "?sort=note",
      "?order=sideways",
      "?limit=0",
      "?limit=101",
    ]) {
      const res = await req("GET", `/api/v1/admin/jobs${qs}`, TOK_ADMIN);
      expect(res.status, qs).toBe(400);
      expect(((await res.json()) as { error_code: string }).error_code).toBe(
        "validation_failed",
      );
    }
  });
});

// ---------------- R4：GET /admin/quality/issues ----------------

describe("GET /admin/quality/issues", () => {
  beforeEach(async () => {
    await enableMfa(TOK_ADMIN);
  });

  async function issues(params = "") {
    const res = await req(
      "GET",
      `/api/v1/admin/quality/issues${params}`,
      TOK_ADMIN,
    );
    expect(res.status).toBe(200);
    return res.json() as Promise<{
      items: Array<{
        issue_kind: string;
        source_id: string;
        source_name: string;
        occurred_at: string;
        note: string | null;
        locator: Record<string, unknown>;
      }>;
      count: number;
      counts: Record<string, number>;
    }>;
  }

  /** 手插非 valid 观测（04E 清洗口径下 outlier 会保留标记，这里直接构造行） */
  function seedBadObs(
    observationId: string,
    qualityStatus: string,
    batchId: string | null,
  ): void {
    ctx.pub
      .prepare(
        `INSERT INTO price_observations
           (observation_id, source_id, object_type, object_id, price_type,
            metric_code, unit_price_yuan_sqm, sample_count, stat_date,
            quality_status, payload_hash, connector_version, batch_id)
         VALUES (?, ?, 'community', 'cmt_06d_x', 'listing_ask',
            'listing_ask_unit', 999999, 1, ?, ?, 'hash-x', 'radar-connector/0.6.0', ?)`,
      )
      .run(observationId, SRC, STAT_DATE, qualityStatus, batchId);
  }

  it("三类异常聚合：每类 locator 定位要素齐备（验收一）", async () => {
    // 1) failed job（含 connector_version/error_code）
    await jobStart("j_06d_bad", {
      connector_version: "radar-connector/0.6.2",
      workflow_url: "https://github.com/o/r/actions/runs/9",
    });
    const fin = await postSigned("/api/v1/internal/jobs/j_06d_bad/finish", {
      status: "failed",
      error_code: "PARSE_SCHEMA_DRIFT",
      note: "字段漂移",
    });
    expect(fin.res.status).toBe(202);
    // 2) 健康 down（最新一条 ≠ ok；更早的 ok 不遮蔽）
    ctx.priv
      .prepare(
        `INSERT INTO source_health_reports (report_id, source_id, status, detail, checked_at)
         VALUES ('h_old', ?, 'ok', NULL, '2026-11-10 08:00:00')`,
      )
      .run(SRC);
    ctx.priv
      .prepare(
        `INSERT INTO source_health_reports (report_id, source_id, status, detail, checked_at)
         VALUES ('h_new', ?, 'down', '连续 3 次超时', '2026-11-15 08:00:00')`,
      )
      .run(SRC);
    // 3) 非 valid 观测（batch 定位链）
    seedBadObs("o_06d_out", "outlier", "b_06d_out");
    seedBadObs("o_06d_stale", "stale", null); // 手工补录：batch null 兜底
    // 干扰项：valid 观测与 ok 来源不进异常
    const { res } = await postSigned(
      "/api/v1/internal/ingest/batch",
      obsPayload("b_06d_ok", [obs({ object_id: "cmt_06d_ok" })]),
    );
    expect(res.status).toBe(202);

    const b = await issues();
    expect(b.counts).toEqual({ job_failed: 1, health: 1, observation: 2 });
    expect(b.items).toHaveLength(4);

    const job = b.items.find((i) => i.issue_kind === "job_failed")!;
    expect(job.source_name).toBe("TEST-来源");
    expect(job.locator).toMatchObject({
      job_id: "j_06d_bad",
      error_code: "PARSE_SCHEMA_DRIFT",
      connector_version: "radar-connector/0.6.2",
      workflow_url: "https://github.com/o/r/actions/runs/9",
    });
    const health = b.items.find((i) => i.issue_kind === "health")!;
    expect(health.locator).toMatchObject({
      report_id: "h_new",
      health_status: "down",
      detail: "连续 3 次超时",
    });
    const outs = b.items.filter((i) => i.issue_kind === "observation");
    expect(outs.map((i) => i.locator.observation_id).sort()).toEqual([
      "o_06d_out",
      "o_06d_stale",
    ]);
    const withBatch = outs.find(
      (i) => i.locator.observation_id === "o_06d_out",
    )!;
    expect(withBatch.locator).toMatchObject({
      batch_id: "b_06d_out",
      connector_version: "radar-connector/0.6.0",
      quality_status: "outlier",
      object_id: "cmt_06d_x",
    });
  });

  it("kind 筛选 + source_id 过滤 + 分页窗口", async () => {
    seedBadObs("o_06d_p1", "low_sample", "b_p");
    seedBadObs("o_06d_p2", "rejected", "b_p");
    const obsOnly = await issues("?kind=observation");
    expect(obsOnly.counts).toEqual({
      job_failed: 0,
      health: 0,
      observation: 2,
    });
    expect(obsOnly.items.every((i) => i.issue_kind === "observation")).toBe(
      true,
    );
    const paged = await issues("?kind=observation&limit=1&offset=1");
    expect(paged.items).toHaveLength(1);
    const otherSrc = await issues("?source_id=src_nonexist");
    expect(otherSrc.items).toEqual([]);
    const badKind = await req(
      "GET",
      "/api/v1/admin/quality/issues?kind=bogus",
      TOK_ADMIN,
    );
    expect(badKind.status).toBe(400);
  });

  it("只读：查询前后 audit_logs 行数不变", async () => {
    const before = (
      ctx.priv.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as {
        n: number;
      }
    ).n;
    await issues();
    const after = (
      ctx.priv.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as {
        n: number;
      }
    ).n;
    expect(after).toBe(before);
  });
});

// ---------------- R5：overview ops 块 ----------------

describe("GET /admin/overview ops 块（四指标卡）", () => {
  it("成功率/更新时间/覆盖小区/来源异常数与种子一致", async () => {
    await enableMfa(TOK_ADMIN);
    // 近 7 日任务：2 成功 1 失败（失败来源 src_official；健康 down 来源同 → 去重 1）
    await jobStart("j_06d_o1");
    await jobFinish("j_06d_o1", { communities_covered: 2 });
    await jobStart("j_06d_o2");
    await jobFinish("j_06d_o2");
    await jobStart("j_06d_o3");
    await postSigned("/api/v1/internal/jobs/j_06d_o3/finish", {
      status: "failed",
      error_code: "E_X",
    });
    ctx.priv
      .prepare(
        `INSERT INTO source_health_reports (report_id, source_id, status, checked_at)
         VALUES ('h_o', 'src_other', 'degraded', '2026-11-15 08:00:00')`,
      )
      .run();
    // 快照：2 小区 valid（其一 stale 不计）+ 1 行政区
    const snap = (
      id: string,
      objectType: string,
      objectId: string,
      quality: string,
      collected: string,
    ) =>
      ctx.pub
        .prepare(
          `INSERT INTO price_snapshots
             (snapshot_id, object_type, object_id, price_type, metric_code,
              sample_count, stat_date, collected_at, quality_status)
           VALUES (?, ?, ?, 'listing_ask', 'community_ask_median_unit', 5, ?, ?, ?)`,
        )
        .run(id, objectType, objectId, STAT_DATE, collected, quality);
    snap("s1", "community", "cmt_a", "valid", "2026-11-15 01:00:00");
    snap("s2", "community", "cmt_b", "valid", "2026-11-16 03:00:00");
    snap("s3", "community", "cmt_c", "stale", "2026-11-16 04:00:00");
    snap("s4", "region", "reg_a", "valid", "2026-11-14 05:00:00");

    const res = await req("GET", "/api/v1/admin/overview", TOK_ADMIN);
    expect(res.status).toBe(200);
    const { ops } = (await res.json()) as {
      ops: Record<string, unknown>;
    };
    expect(ops).toEqual({
      jobs_7d: { succeeded: 2, failed: 1, running: 0 },
      success_rate_7d: Number((2 / 3).toFixed(4)),
      last_update_at: "2026-11-16 03:00:00", // 仅 valid 快照
      communities_covered: 2,
      source_issue_count: 2, // src_official（failed）∪ src_other（degraded）
    });
  });

  it("空库：成功率 null、更新时间 null、覆盖 0、异常 0（既有字段不受影响）", async () => {
    await enableMfa(TOK_ADMIN);
    const res = await req("GET", "/api/v1/admin/overview", TOK_ADMIN);
    const b = (await res.json()) as {
      ops: Record<string, unknown>;
      users: Record<string, unknown>;
    };
    expect(b.ops.success_rate_7d).toBeNull();
    expect(b.ops.last_update_at).toBeNull();
    expect(b.ops.communities_covered).toBe(0);
    expect(b.ops.source_issue_count).toBe(0);
    expect(b.users.total).toBe(2); // 06B 既有语义不变
  });
});
