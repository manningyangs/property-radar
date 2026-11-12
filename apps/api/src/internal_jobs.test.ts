// TASK-04B：internal 任务/健康/资格预检端点（PRD 任务行 1288–1294 / §10.4 / §11.1-2）
// 覆盖：jobs/start 门禁与幂等、jobs/:id/finish 404 与幂等、health 落行与 schema、
// eligibility 完全走 source-gate（未 approved/超范围/未知/惰性过期）、共享签名校验链回归。
// ingest/batch 的完整签名链验收在 internal.test.ts（04A），本文件以抽样回归确认提取共享函数后行为不变。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createTestEnv, type TestContext } from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const SECRET = "test-ingest-secret-04b";
const CITY = "TEST-0001";
const SOURCE = "src_official";

beforeEach(() => {
  ctx = createTestEnv();
  app = createApp();
  ctx.env.INGEST_HMAC_SECRET = SECRET;
  seedCity(CITY, "active");
});

function seedCity(code: string, status: string): void {
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status) VALUES (?, ?, 'TEST-P', ?)",
    )
    .run(code, `TEST-城市${code}`, status);
}

function seedSource(status: string, validUntil: string | null = null): void {
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, 'TEST-官方来源（虚构）', 'open_data')",
    )
    .run(SOURCE);
  ctx.pub
    .prepare(
      "INSERT INTO source_license_state (source_id, status, valid_until) VALUES (?, ?, ?)",
    )
    .run(SOURCE, status, validUntil);
}

function seedCoverage(
  cityCode = CITY,
  level = "community",
  authz = "approved_open",
): void {
  ctx.pub
    .prepare(
      `INSERT INTO source_city_coverage
         (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
       VALUES (?, ?, ?, '["community_ask_median_unit"]', ?, datetime('now'))`,
    )
    .run(SOURCE, cityCode, level, authz);
}

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
function newNonce(): string {
  nonceSeq += 1;
  return `nonce-${String(nonceSeq).padStart(4, "0")}-04b`;
}

interface SignOpts {
  secret?: string;
  ts?: string;
  nonce?: string;
  /** 覆盖签名计算（默认对原始 body 签名） */
  signBody?: string;
  /** 不携带签名头（测缺签名场景） */
  noSignature?: boolean;
}

/** 通用带签名 POST（与 04A ingest/batch 同一签名口径） */
async function postSigned(
  path: string,
  payload: unknown,
  opts: SignOpts = {},
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? newNonce();
  const secret = opts.secret ?? SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Ingest-Timestamp": ts,
    "X-Ingest-Nonce": nonce,
  };
  if (!opts.noSignature) {
    headers["X-Ingest-Signature"] = await hmacHex(
      secret,
      `${ts}.${nonce}.${opts.signBody ?? raw}`,
    );
  }
  return app.request(path, { method: "POST", headers, body: raw }, ctx.env);
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error_code: string }).error_code;
}

function jobCount(): number {
  return (
    ctx.priv.prepare("SELECT COUNT(*) AS n FROM ingest_jobs").get() as {
      n: number;
    }
  ).n;
}

function healthCount(): number {
  return (
    ctx.priv
      .prepare("SELECT COUNT(*) AS n FROM source_health_reports")
      .get() as { n: number }
  ).n;
}

const JOB_START = "/api/v1/internal/jobs/start";
const ELIGIBILITY = `/api/v1/internal/sources/${SOURCE}/eligibility`;

describe("POST /internal/jobs/start：任务开始前过 source-gate 门禁", () => {
  it("pending_review + 合法签名 → 403 source_not_approved，ingest_jobs 无新行", async () => {
    seedSource("pending_review");
    seedCoverage();
    const res = await postSigned(JOB_START, {
      job_id: "job_04b_001",
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");
    expect(jobCount()).toBe(0);
  });

  it("approved → 202 started，行字段正确（status=running）", async () => {
    seedSource("approved_open");
    seedCoverage();
    const res = await postSigned(JOB_START, {
      job_id: "job_04b_ok",
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      job_id: "job_04b_ok",
      status: "started",
    });
    const row = ctx.priv
      .prepare(
        "SELECT source_id, city_code, status, started_at FROM ingest_jobs WHERE job_id = ?",
      )
      .get("job_04b_ok") as {
      source_id: string;
      city_code: string;
      status: string;
      started_at: string;
    };
    expect(row).toMatchObject({
      source_id: SOURCE,
      city_code: CITY,
      status: "running",
    });
    expect(row.started_at).toBeTruthy();
  });

  it("同 job_id 重复 start → 202 duplicate（幂等，不重复写入）", async () => {
    seedSource("approved_open");
    seedCoverage();
    const payload = {
      job_id: "job_dup",
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    };
    const first = await postSigned(JOB_START, payload);
    expect(first.status).toBe(202);
    const again = await postSigned(JOB_START, payload);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({
      job_id: "job_dup",
      status: "duplicate",
    });
    expect(jobCount()).toBe(1);
  });

  it("超范围城市起任务同样被拒（gate 复用）", async () => {
    seedSource("approved_open");
    seedCoverage();
    const res = await postSigned(JOB_START, {
      job_id: "job_scope",
      source_id: SOURCE,
      city_code: "TEST-9999",
      object_level: "community",
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
    expect(jobCount()).toBe(0);
  });

  it("缺 INGEST_HMAC_SECRET → 403 ingest_disabled（共享禁用语义）", async () => {
    seedSource("approved_open");
    seedCoverage();
    delete ctx.env.INGEST_HMAC_SECRET;
    const res = await postSigned(JOB_START, {
      job_id: "job_nosecret",
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("ingest_disabled");
  });
});

describe("POST /internal/jobs/:id/finish：任务完成", () => {
  beforeEach(async () => {
    seedSource("approved_open");
    seedCoverage();
    await postSigned(JOB_START, {
      job_id: "job_f1",
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    });
  });

  it("未知 job → 404 job_not_found", async () => {
    const res = await postSigned("/api/v1/internal/jobs/job_ghost/finish", {
      status: "succeeded",
    });
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("job_not_found");
  });

  it("finish failed → 行 status=failed、finished_at 与 error_code 落库", async () => {
    const res = await postSigned("/api/v1/internal/jobs/job_f1/finish", {
      status: "failed",
      error_code: "parse_error",
      note: "fixture 解析失败（虚构）",
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ job_id: "job_f1", status: "failed" });
    const row = ctx.priv
      .prepare(
        "SELECT status, finished_at, error_code FROM ingest_jobs WHERE job_id = ?",
      )
      .get("job_f1") as {
      status: string;
      finished_at: string | null;
      error_code: string;
    };
    expect(row).toMatchObject({
      status: "failed",
      error_code: "parse_error",
    });
    expect(row.finished_at).toBeTruthy();
  });

  it("重复 finish → 幂等返回当前状态，不改写原记录", async () => {
    await postSigned("/api/v1/internal/jobs/job_f1/finish", {
      status: "failed",
      error_code: "parse_error",
    });
    const first = ctx.priv
      .prepare("SELECT finished_at FROM ingest_jobs WHERE job_id = ?")
      .get("job_f1") as { finished_at: string };

    const again = await postSigned("/api/v1/internal/jobs/job_f1/finish", {
      status: "succeeded",
    });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ job_id: "job_f1", status: "failed" });
    const row = ctx.priv
      .prepare(
        "SELECT status, error_code, finished_at FROM ingest_jobs WHERE job_id = ?",
      )
      .get("job_f1") as {
      status: string;
      error_code: string;
      finished_at: string;
    };
    expect(row.status).toBe("failed");
    expect(row.error_code).toBe("parse_error");
    expect(row.finished_at).toBe(first.finished_at);
  });

  it("非法 status → 400 validation_failed", async () => {
    const res = await postSigned("/api/v1/internal/jobs/job_f1/finish", {
      status: "paused",
    });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation_failed");
  });
});

describe("POST /internal/health/source：来源健康上报", () => {
  it("合法上报 → 202 recorded，行字段正确", async () => {
    const res = await postSigned("/api/v1/internal/health/source", {
      source_id: SOURCE,
      status: "degraded",
      latency_ms: 1500,
      detail: "端点响应变慢（虚构）",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { report_id: string; status: string };
    expect(body.status).toBe("recorded");
    const row = ctx.priv
      .prepare(
        "SELECT source_id, status, latency_ms FROM source_health_reports WHERE report_id = ?",
      )
      .get(body.report_id) as {
      source_id: string;
      status: string;
      latency_ms: number;
    };
    expect(row).toEqual({
      source_id: SOURCE,
      status: "degraded",
      latency_ms: 1500,
    });
    expect(healthCount()).toBe(1);
  });

  it("健康上报不设资格门禁：未登记来源也可记录 down", async () => {
    const res = await postSigned("/api/v1/internal/health/source", {
      source_id: "src_unregistered",
      status: "down",
    });
    expect(res.status).toBe(202);
    expect(healthCount()).toBe(1);
  });

  it("非法 status → 400 validation_failed；负 latency 被拒", async () => {
    const bad = await postSigned("/api/v1/internal/health/source", {
      source_id: SOURCE,
      status: "healthy",
    });
    expect(bad.status).toBe(400);
    expect(await errCode(bad)).toBe("validation_failed");
    const neg = await postSigned("/api/v1/internal/health/source", {
      source_id: SOURCE,
      status: "ok",
      latency_ms: -5,
    });
    expect(neg.status).toBe(400);
    expect(healthCount()).toBe(0);
  });

  it("缺签名头 → 403 signature_invalid", async () => {
    const res = await postSigned(
      "/api/v1/internal/health/source",
      { source_id: SOURCE, status: "ok" },
      { noSignature: true },
    );
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("signature_invalid");
    expect(healthCount()).toBe(0);
  });
});

describe("POST /internal/sources/:id/eligibility：运行前资格预检", () => {
  it("未知 source → 404 source_not_found", async () => {
    const res = await postSigned(
      "/api/v1/internal/sources/src_ghost/eligibility",
      {},
    );
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("source_not_found");
  });

  it("pending_review（仅 source_id）→ 403 source_not_approved", async () => {
    seedSource("pending_review");
    const res = await postSigned(ELIGIBILITY, {});
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");
  });

  it("approved（仅 source_id）→ 200 eligible:true 含 status/valid_until", async () => {
    seedSource("approved_open", null);
    const res = await postSigned(ELIGIBILITY, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      eligible: true,
      source_id: SOURCE,
      status: "approved_open",
      valid_until: null,
    });
  });

  it("带 coverage：范围内 → 200；覆盖外 → 403 city_coverage_denied", async () => {
    seedSource("approved_open");
    seedCoverage(CITY, "community");
    const ok = await postSigned(ELIGIBILITY, {
      city_code: CITY,
      object_level: "community",
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { eligible: boolean }).toMatchObject({
      eligible: true,
    });

    const out = await postSigned(ELIGIBILITY, {
      city_code: CITY,
      object_level: "listing",
    });
    expect(out.status).toBe(403);
    expect(await errCode(out)).toBe("city_coverage_denied");
  });

  it("惰性过期：valid_until 已过 → 403 且库中状态已自动 suspended", async () => {
    seedSource("approved_open", "2020-01-01");
    const res = await postSigned(ELIGIBILITY, {});
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");
    expect(
      (
        ctx.pub
          .prepare(
            "SELECT status FROM source_license_state WHERE source_id = ?",
          )
          .get(SOURCE) as { status: string }
      ).status,
    ).toBe("suspended");
  });

  it("city_code 与 object_level 不同给同缺 → 400", async () => {
    seedSource("approved_open");
    seedCoverage();
    const res = await postSigned(ELIGIBILITY, { city_code: CITY });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("bad_request");
  });

  it("缺 INGEST_HMAC_SECRET → 403 ingest_disabled", async () => {
    seedSource("approved_open");
    delete ctx.env.INGEST_HMAC_SECRET;
    const res = await postSigned(ELIGIBILITY, {});
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("ingest_disabled");
  });
});

describe("共享签名校验链回归（提取后 ingest/batch 行为不变）", () => {
  it("合法签名批次 202、篡改 body 403、时间戳过期 403", async () => {
    seedSource("approved_open");
    seedCoverage();
    const payload = {
      batch_id: "batch_regress",
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    };
    const ok = await postSigned("/api/v1/internal/ingest/batch", payload);
    expect(ok.status).toBe(202);

    const tampered = await postSigned(
      "/api/v1/internal/ingest/batch",
      { ...payload, batch_id: "batch_x", object_level: "listing" },
      { signBody: JSON.stringify(payload) },
    );
    expect(tampered.status).toBe(403);
    expect(await errCode(tampered)).toBe("signature_invalid");

    const stale = await postSigned(
      "/api/v1/internal/ingest/batch",
      { ...payload, batch_id: "batch_stale" },
      { ts: String(Math.floor(Date.now() / 1000) - 400) },
    );
    expect(stale.status).toBe(403);
    expect(await errCode(stale)).toBe("stale_timestamp");
  });
});
