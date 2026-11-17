// TASK-04A：internal 批次端点与来源门禁验收（PRD 任务行 1284–1286 / §10.4 / §5.6 / §11.1）
// 核心验收：
//   验收一 pending_review + 合法签名 → 403 source_not_approved（不落批次）；
//   验收二 approved 批次受理后 suspend → 下一批 403（无新批次行）；
// 另覆盖：超范围批次、未知来源、过期自动 suspend、签名链（缺 secret/时间戳/nonce/篡改 body）与受理记录。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createTestEnv, seedUser, type TestContext } from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const SECRET = "test-ingest-secret-04a";
const CITY = "TEST-0001";
const SOURCE = "src_official";

beforeEach(() => {
  ctx = createTestEnv();
  app = createApp();
  ctx.env.INGEST_HMAC_SECRET = SECRET; // 未配置的场景由单测内 delete 覆盖
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

/** HMAC-SHA256 → 小写 hex（与 runtime 口径一致：`${ts}.${nonce}.${body}`） */
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
  return `nonce-${String(nonceSeq).padStart(4, "0")}-04a`;
}

interface SignOpts {
  secret?: string;
  ts?: string;
  nonce?: string;
  /** 覆盖签名计算（默认对原始 body 签名） */
  signBody?: string;
}

function defaultPayload(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: "batch_04a_001",
    source_id: SOURCE,
    city_code: CITY,
    object_level: "community",
    observed_count: 42,
    ...overrides,
  };
}

async function postBatch(
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
    "X-Ingest-Signature": await hmacHex(
      secret,
      `${ts}.${nonce}.${opts.signBody ?? raw}`,
    ),
  };
  return app.request(
    "/api/v1/internal/ingest/batch",
    { method: "POST", headers, body: raw },
    ctx.env,
  );
}

function batchCount(): number {
  return (
    ctx.priv.prepare("SELECT COUNT(*) AS n FROM ingest_batches").get() as {
      n: number;
    }
  ).n;
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error_code: string }).error_code;
}

describe("验收一：未审批来源不可入管线", () => {
  it("pending_review + 合法签名 → 403 source_not_approved，不写 ingest_batches", async () => {
    seedSource("pending_review");
    seedCoverage();
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");
    expect(batchCount()).toBe(0);
  });
});

describe("验收二：停用后下一批任务不得执行", () => {
  it("approved 批次 202 受理 → suspend → 下一批 403（无新批次行）", async () => {
    seedSource("approved_open");
    seedCoverage();
    const first = await postBatch(defaultPayload());
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      batch_id: "batch_04a_001",
      status: "accepted",
    });
    expect(batchCount()).toBe(1);

    // 停用（与 POST /admin/sources/:id/suspend 同一 SQL 语义）
    ctx.pub
      .prepare(
        "UPDATE source_license_state SET status = 'suspended' WHERE source_id = ?",
      )
      .run(SOURCE);
    ctx.pub
      .prepare(
        "UPDATE source_city_coverage SET authorization_status = 'suspended' WHERE source_id = ?",
      )
      .run(SOURCE);

    const second = await postBatch(
      defaultPayload({ batch_id: "batch_04a_002" }),
    );
    expect(second.status).toBe(403);
    expect(await errCode(second)).toBe("source_not_approved");
    expect(batchCount()).toBe(1);
  });

  it("discovered/manual_only/未知来源同样被拒（403/404）", async () => {
    seedSource("manual_only");
    seedCoverage();
    expect((await postBatch(defaultPayload())).status).toBe(403);

    // 未知 source：404 source_not_found（须有 coverage 的假来源不在 data_sources_public 中）
    const res = await postBatch(
      defaultPayload({ source_id: "src_ghost", batch_id: "b_ghost" }),
    );
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("source_not_found");
  });
});

describe("超范围批次被拒绝（PRD 04A「拒绝超范围批次」）", () => {
  it("缺 coverage 行 → 403 city_coverage_denied", async () => {
    seedSource("approved_open"); // 未 seedCoverage
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
    expect(batchCount()).toBe(0);
  });

  it("object_level 超范围 → 403", async () => {
    seedSource("approved_open");
    seedCoverage(CITY, "community");
    const res = await postBatch(
      defaultPayload({ object_level: "listing", batch_id: "b_lvl" }),
    );
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
  });

  it("城市不在 coverage → 403；城市 status 非 active/limited → 403", async () => {
    seedCity("TEST-0002", "requestable");
    seedSource("approved_open");
    seedCoverage();
    const otherCity = await postBatch(
      defaultPayload({ city_code: "TEST-0002", batch_id: "b_city" }),
    );
    expect(otherCity.status).toBe(403);
    expect(await errCode(otherCity)).toBe("city_coverage_denied");

    // 城市被停采（目录在、coverage 在，但城市 status=suspended）
    ctx.pub
      .prepare("UPDATE cities SET status = 'suspended' WHERE city_code = ?")
      .run(CITY);
    const suspended = await postBatch(defaultPayload({ batch_id: "b_city2" }));
    expect(suspended.status).toBe(403);
    expect(await errCode(suspended)).toBe("city_coverage_denied");
  });

  it("coverage 授权未批准（pending_review/suspended 行）→ 403", async () => {
    seedSource("approved_open");
    seedCoverage(CITY, "community", "pending_review");
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
  });
});

describe("授权到期自动 suspend（惰性）", () => {
  it("valid_until 已过 → 批次 403 且库中状态已 suspended + 覆盖同步 + 审计留痕", async () => {
    seedSource("approved_open", "2020-01-01");
    seedCoverage();
    const res = await postBatch(defaultPayload());
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
    expect(
      (
        ctx.pub
          .prepare(
            "SELECT authorization_status FROM source_city_coverage WHERE source_id = ?",
          )
          .get(SOURCE) as { authorization_status: string }
      ).authorization_status,
    ).toBe("suspended");
    expect(
      ctx.priv
        .prepare("SELECT action, reason FROM audit_logs WHERE resource_id = ?")
        .get(SOURCE) as { action: string; reason: string },
    ).toMatchObject({
      action: "source.auto_suspend",
      reason: "license_expired",
    });
  });

  it("valid_until 未过 → 批次受理成功", async () => {
    const future = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    seedSource("approved_licensed", future);
    seedCoverage();
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(202);
  });
});

describe("HMAC 签名与防重放", () => {
  beforeEach(() => {
    seedSource("approved_open");
    seedCoverage();
  });

  it("未配置 INGEST_HMAC_SECRET → 403 ingest_disabled", async () => {
    delete ctx.env.INGEST_HMAC_SECRET;
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("ingest_disabled");
    expect(batchCount()).toBe(0);
  });

  it("错误签名 → 403 signature_invalid", async () => {
    const res = await postBatch(defaultPayload(), {
      secret: "wrong-secret-04a",
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("signature_invalid");
    expect(batchCount()).toBe(0);
  });

  it("body 被篡改（签名覆盖原文）→ 403 signature_invalid", async () => {
    const payload = defaultPayload();
    const tampered = { ...payload, object_level: "listing" };
    const res = await postBatch(tampered, {
      signBody: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("signature_invalid");
  });

  it("时间戳偏差 >300s → 403 stale_timestamp", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 400);
    const res = await postBatch(defaultPayload({ batch_id: "b_stale" }), {
      ts: stale,
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("stale_timestamp");
  });

  it("缺失/非法 nonce → 403 replay_detected", async () => {
    const raw = JSON.stringify(defaultPayload({ batch_id: "b_nononce" }));
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await app.request(
      "/api/v1/internal/ingest/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ingest-Timestamp": ts,
          "X-Ingest-Signature": await hmacHex(SECRET, `${ts}..${raw}`),
        },
        body: raw,
      },
      ctx.env,
    );
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("replay_detected");
  });

  it("重放同 (timestamp, nonce, body) → 403 replay_detected", async () => {
    const payload = defaultPayload({ batch_id: "b_replay" });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "replay-nonce-04a";
    const first = await postBatch(payload, { ts, nonce });
    expect(first.status).toBe(202);
    const second = await postBatch(payload, { ts, nonce });
    expect(second.status).toBe(403);
    expect(await errCode(second)).toBe("replay_detected");
    expect(batchCount()).toBe(1);
  });

  it("受理记录字段正确；同 batch_id 换 nonce 再交 → 202 duplicate（幂等，不重复写入）", async () => {
    const res = await postBatch(defaultPayload({ batch_id: "b_dup" }));
    expect(res.status).toBe(202);
    const row = ctx.priv
      .prepare(
        "SELECT source_id, city_code, object_level FROM ingest_batches WHERE batch_id = ?",
      )
      .get("b_dup") as {
      source_id: string;
      city_code: string;
      object_level: string;
    };
    expect(row).toEqual({
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    });

    const again = await postBatch(defaultPayload({ batch_id: "b_dup" }));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({
      batch_id: "b_dup",
      status: "duplicate",
    });
    expect(batchCount()).toBe(1);
  });

  it("签名通过但 body 不符合 schema → 400 validation_failed", async () => {
    const payload: Record<string, unknown> = defaultPayload();
    delete payload["city_code"];
    const res = await postBatch(payload);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation_failed");
    expect(batchCount()).toBe(0);
  });
});

// ===================== TASK-04D：批内 observations 落库与快照聚合（spec R2） =====================

describe("TASK-04D：批次携带观测明细落库与聚合", () => {
  // 04E 起清洗含未来日期与过期物化判定：固定日期会随时钟失效，统一取沪市昨日
  const STAT_DATE = new Date(Date.now() - 86_400_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const CMT = "cmt_qd_01";

  function obs(overrides: Record<string, unknown> = {}) {
    return {
      object_id: CMT,
      property_type: "resale",
      price_type: "listing_ask",
      metric_code: "listing_ask_unit",
      price_total_fen: 300000000,
      unit_price_yuan_sqm: 30000,
      area_sqm: 100,
      sample_count: 1,
      stat_date: STAT_DATE,
      quality_status: "valid",
      connector_version: "fang_community/0.1.0",
      ...overrides,
    };
  }

  function obsPayload(
    observations: unknown[],
    overrides: Record<string, unknown> = {},
  ) {
    return defaultPayload({
      observed_count: observations.length,
      observations,
      ...overrides,
    });
  }

  function obsRowCount(): number {
    return (
      ctx.pub.prepare("SELECT COUNT(*) AS n FROM price_observations").get() as {
        n: number;
      }
    ).n;
  }

  beforeEach(() => {
    seedSource("approved_open");
    seedCoverage();
  });

  it("5 套样本落库 + 聚合 valid：median/p25/p75/mean 线性插值、响应附计数", async () => {
    const units = [28000, 29000, 30000, 31000, 32000];
    const res = await postBatch(
      obsPayload(
        units.map((u) => obs({ unit_price_yuan_sqm: u })),
        {
          batch_id: "b_04d_001",
        },
      ),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      batch_id: "b_04d_001",
      status: "accepted",
      observations_written: 5,
      snapshots_upserted: 1,
      duplicates_dropped: 0,
      stale_count: 0,
    });
    expect(obsRowCount()).toBe(5);

    const snap = ctx.pub
      .prepare(
        `SELECT price_type, metric_code, median, mean, p25, p75,
                sample_count, stat_date, quality_status, source_id, collected_at,
                method_version
         FROM price_snapshots WHERE object_id = ?`,
      )
      .get(CMT) as Record<string, unknown>;
    expect(snap).toMatchObject({
      price_type: "listing_ask",
      metric_code: "community_ask_median_unit",
      median: 30000,
      mean: 30000,
      p25: 29000,
      p75: 31000,
      sample_count: 5,
      stat_date: STAT_DATE,
      quality_status: "valid",
      source_id: SOURCE,
    });
    expect(snap["collected_at"]).toBeTruthy();
    // TASK-04E：口径版本化——快照留痕 method_version（spec R2 唯一真源 cleaning.ts）
    expect(snap["method_version"]).toBe("09-aggregate-v3");
  });

  it("少于 5 套 → low_sample 降级但 median 仍留痕（PRD §4.4）", async () => {
    const res = await postBatch(
      obsPayload(
        [
          obs({ unit_price_yuan_sqm: 30000 }),
          obs({ unit_price_yuan_sqm: 34000 }),
        ],
        { batch_id: "b_04d_002" },
      ),
    );
    expect(res.status).toBe(202);
    const snap = ctx.pub
      .prepare(
        "SELECT median, sample_count, quality_status FROM price_snapshots WHERE object_id = ?",
      )
      .get(CMT) as Record<string, unknown>;
    expect(snap).toMatchObject({
      median: 32000, // 两样本线性插值 = 均值
      sample_count: 2,
      quality_status: "low_sample",
    });
  });

  it("同观测换 batch_id 重交幂等不重复行；同 batch_id 再交 202 duplicate 不重写", async () => {
    const observations = [
      obs({ unit_price_yuan_sqm: 31000, area_sqm: 89 }),
      obs({ unit_price_yuan_sqm: 33000, area_sqm: 95 }),
    ];
    const payload = obsPayload(observations, { batch_id: "b_04d_003" });
    const first = await postBatch(payload);
    expect(first.status).toBe(202);
    expect(obsRowCount()).toBe(2);
    const idBefore = (
      ctx.pub
        .prepare(
          "SELECT observation_id FROM price_observations ORDER BY observation_id",
        )
        .all() as Array<{ observation_id: string }>
    ).map((r) => r.observation_id);

    // 换 batch_id、同观测内容：确定性 observation_id → 幂等，行数不变
    const second = await postBatch(
      obsPayload(observations, { batch_id: "b_04d_004" }),
    );
    expect(second.status).toBe(202);
    expect(obsRowCount()).toBe(2);
    const idAfter = (
      ctx.pub
        .prepare(
          "SELECT observation_id FROM price_observations ORDER BY observation_id",
        )
        .all() as Array<{ observation_id: string }>
    ).map((r) => r.observation_id);
    expect(idAfter).toEqual(idBefore);

    // 同 batch_id 再交 → duplicate，不重写（observations 不再计数）
    const dup = await postBatch(payload);
    expect(dup.status).toBe(202);
    expect(await dup.json()).toEqual({
      batch_id: "b_04d_003",
      status: "duplicate",
    });
    expect(obsRowCount()).toBe(2);
  });

  it("observed_count 与 observations 长度不一致 → 400，零受理零落库", async () => {
    const res = await postBatch(
      obsPayload([obs()], {
        batch_id: "b_04d_005",
        observed_count: 9,
      }),
    );
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation_failed");
    expect(batchCount()).toBe(0);
    expect(obsRowCount()).toBe(0);
  });

  it("总价与单价均为空 → 400；observations 超 maxItems 500 → 400", async () => {
    const empty = await postBatch(
      obsPayload([obs({ price_total_fen: null, unit_price_yuan_sqm: null })], {
        batch_id: "b_04d_006",
      }),
    );
    expect(empty.status).toBe(400);
    expect(await errCode(empty)).toBe("validation_failed");

    const tooMany = await postBatch(
      obsPayload(
        Array.from({ length: 501 }, (_, i) => obs({ object_id: `cmt_${i}` })),
        {
          batch_id: "b_04d_007",
        },
      ),
    );
    expect(tooMany.status).toBe(400);
    expect(await errCode(tooMany)).toBe("validation_failed");
    expect(obsRowCount()).toBe(0);
    expect(batchCount()).toBe(0);
  });

  it("门禁回归：pending_review 来源带 observations → 403，零落库", async () => {
    ctx.pub
      .prepare(
        "UPDATE source_license_state SET status = 'pending_review' WHERE source_id = ?",
      )
      .run(SOURCE);
    const res = await postBatch(obsPayload([obs()], { batch_id: "b_04d_008" }));
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");
    expect(batchCount()).toBe(0);
    expect(obsRowCount()).toBe(0);
  });

  it("TASK-09 R3 双源交叉核验：有效源间中位数偏差 >15% → 快照标 outlier（median 仍写入留痕）", async () => {
    const objectId = "cmt_x9_outlier";
    ctx.pub
      .prepare(
        "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_official_x9', 'TEST-来源X9（虚构）', 'open_data')",
      )
      .run();
    ctx.pub
      .prepare(
        "INSERT INTO source_license_state (source_id, status, valid_until) VALUES ('src_official_x9', 'approved_open', NULL)",
      )
      .run();
    ctx.pub
      .prepare(
        `INSERT INTO source_city_coverage
           (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
         VALUES ('src_official_x9', ?, 'community', '["community_ask_median_unit"]', 'approved_open', datetime('now'))`,
      )
      .run(CITY);

    // 源 A 中位数 30000、源 B 中位数 34530 → 相对偏差 15.1% > 15% 阈值
    const aUnits = [28000, 29000, 30000, 31000, 32000];
    const bUnits = [33530, 34030, 34530, 35030, 35530];
    const a = await postBatch(
      obsPayload(
        aUnits.map((u) => obs({ object_id: objectId, unit_price_yuan_sqm: u })),
        { batch_id: "b_x9_a" },
      ),
    );
    expect(a.status).toBe(202);
    const b = await postBatch(
      obsPayload(
        bUnits.map((u) => obs({ object_id: objectId, unit_price_yuan_sqm: u })),
        { batch_id: "b_x9_b", source_id: "src_official_x9" },
      ),
    );
    expect(b.status).toBe(202);

    const snap = ctx.pub
      .prepare(
        "SELECT median, sample_count, quality_status, method_version FROM price_snapshots WHERE object_id = ?",
      )
      .get(objectId) as Record<string, unknown>;
    expect(snap["quality_status"]).toBe("outlier");
    expect(snap["sample_count"]).toBe(10);
    expect(snap["median"]).not.toBeNull(); // 留痕不隐藏：统计量照常全量写入
    expect(snap["method_version"]).toBe("09-aggregate-v3");

    // 阈值内对照：另一对象双源偏差 14.9% → 不触发，维持 valid
    const okId = "cmt_x9_ok";
    const okB = [33470, 33970, 34470, 34970, 35470]; // median 34470 → 14.9%
    const okA = await postBatch(
      obsPayload(
        aUnits.map((u) => obs({ object_id: okId, unit_price_yuan_sqm: u })),
        { batch_id: "b_x9_ok_a" },
      ),
    );
    expect(okA.status).toBe(202);
    const okBRes = await postBatch(
      obsPayload(
        okB.map((u) => obs({ object_id: okId, unit_price_yuan_sqm: u })),
        { batch_id: "b_x9_ok_b", source_id: "src_official_x9" },
      ),
    );
    expect(okBRes.status).toBe(202);
    const okSnap = ctx.pub
      .prepare("SELECT quality_status FROM price_snapshots WHERE object_id = ?")
      .get(okId) as Record<string, unknown>;
    expect(okSnap["quality_status"]).toBe("valid");
  });
});

// ===================== TASK-04E：清洗规则接入批次端点（spec R1 / SubTask 1.3） =====================

describe("TASK-04E：批内清洗规则（先于门禁与 DB 写，400 零行）", () => {
  const CMT = "cmt_qd_04e";
  /** 沪市日期（与清洗模块 shanghaiDate 同口径：UTC+8 平移取日） */
  const shDate = (ms: number) =>
    new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
  const YESTERDAY = shDate(Date.now() - 86_400_000);

  function obs(overrides: Record<string, unknown> = {}) {
    return {
      object_id: CMT,
      property_type: "resale",
      price_type: "listing_ask",
      metric_code: "listing_ask_unit",
      price_total_fen: 300000000,
      unit_price_yuan_sqm: 30000,
      area_sqm: 100,
      sample_count: 1,
      stat_date: YESTERDAY,
      quality_status: "valid",
      connector_version: "fang_community/0.1.0",
      ...overrides,
    };
  }

  function obsPayload(
    observations: unknown[],
    overrides: Record<string, unknown> = {},
  ) {
    return defaultPayload({
      observed_count: observations.length,
      observations,
      ...overrides,
    });
  }

  function obsRowCount(): number {
    return (
      ctx.pub.prepare("SELECT COUNT(*) AS n FROM price_observations").get() as {
        n: number;
      }
    ).n;
  }

  async function detailsOf(
    res: Response,
  ): Promise<Array<{ field: string; message: string }>> {
    const b = (await res.json()) as {
      details?: Array<{ field: string; message: string }>;
    };
    return b.details ?? [];
  }

  beforeEach(() => {
    seedSource("approved_open");
    seedCoverage();
  });

  it("极端价格（单价 999999 元/㎡、总价 2 亿元）→ 400 字段级 details，零受理零落库", async () => {
    const res = await postBatch(
      obsPayload(
        [
          obs({ unit_price_yuan_sqm: 999999 }),
          obs({ price_total_fen: 20_000_000_000, unit_price_yuan_sqm: 20000 }),
        ],
        { batch_id: "b_04e_001" },
      ),
    );
    expect(res.status).toBe(400);
    const details = await detailsOf(res);
    expect(details).toContainEqual(
      expect.objectContaining({ field: "/observations/0/unit_price_yuan_sqm" }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({ field: "/observations/1/price_total_fen" }),
    );
    expect(batchCount()).toBe(0);
    expect(obsRowCount()).toBe(0);
  });

  it("未来日期（沪市 T+1）→ 400 details stat_date 字段，零行", async () => {
    const res = await postBatch(
      obsPayload([obs({ stat_date: shDate(Date.now() + 86_400_000) })], {
        batch_id: "b_04e_002",
      }),
    );
    expect(res.status).toBe(400);
    const details = await detailsOf(res);
    expect(details).toContainEqual(
      expect.objectContaining({ field: "/observations/0/stat_date" }),
    );
    expect(batchCount()).toBe(0);
    expect(obsRowCount()).toBe(0);
  });

  it("语义 area_sqm = 0 → 400 details 字段路径，零行", async () => {
    const res = await postBatch(
      obsPayload([obs({ area_sqm: 0 })], { batch_id: "b_04e_003" }),
    );
    expect(res.status).toBe(400);
    const details = await detailsOf(res);
    expect(details).toContainEqual(
      expect.objectContaining({ field: "/observations/0/area_sqm" }),
    );
    expect(batchCount()).toBe(0);
    expect(obsRowCount()).toBe(0);
  });

  it("批内重复 ×2 → 202、duplicates_dropped=1、落库 1 行", async () => {
    const one = obs({ unit_price_yuan_sqm: 27000, area_sqm: 88 });
    const res = await postBatch(
      obsPayload([one, { ...one }], { batch_id: "b_04e_004" }),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      batch_id: "b_04e_004",
      status: "accepted",
      observations_written: 1,
      snapshots_upserted: 1,
      duplicates_dropped: 1,
      stale_count: 0,
    });
    expect(obsRowCount()).toBe(1);
  });

  it("过期（当日 − 40 天，超默认 30 天阈值）→ stale 物化、snapshots_upserted=0", async () => {
    const res = await postBatch(
      obsPayload([obs({ stat_date: shDate(Date.now() - 40 * 86_400_000) })], {
        batch_id: "b_04e_005",
      }),
    );
    expect(res.status).toBe(202);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b).toMatchObject({
      observations_written: 1,
      snapshots_upserted: 0,
      duplicates_dropped: 0,
      stale_count: 1,
    });
    const row = ctx.pub
      .prepare(
        "SELECT quality_status FROM price_observations WHERE object_id = ?",
      )
      .get(CMT) as { quality_status: string };
    expect(row.quality_status).toBe("stale");
    // 过期组无 valid 样本 → 不写快照（不造数）
    const snaps = ctx.pub
      .prepare("SELECT COUNT(*) AS n FROM price_snapshots WHERE object_id = ?")
      .get(CMT) as { n: number };
    expect(snaps.n).toBe(0);
    expect(batchCount()).toBe(1); // 过期照常受理入库（拍板 2），非 400
  });
});

// ===================== TASK-04E：official_index 指数观测入批次（spec R3） =====================

describe("TASK-04E：official_index 指数观测（schema + 清洗 + 不聚快照）", () => {
  const CMT = "cmt_qd_idx";
  const YESTERDAY = new Date(Date.now() - 86_400_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);

  function idxPayload(overrides: Record<string, unknown> = {}) {
    return defaultPayload({
      batch_id: "b_04e_idx",
      observed_count: 1,
      observations: [
        {
          object_id: CMT,
          price_type: "official_index",
          metric_code: "new_house_price_index",
          index_value: 99.5,
          sample_count: 0,
          stat_date: YESTERDAY,
          quality_status: "valid",
          ...overrides,
        },
      ],
    });
  }

  function obsRowCount(): number {
    return (
      ctx.pub.prepare("SELECT COUNT(*) AS n FROM price_observations").get() as {
        n: number;
      }
    ).n;
  }

  function snapshotCount(): number {
    return (
      ctx.pub
        .prepare(
          "SELECT COUNT(*) AS n FROM price_snapshots WHERE object_id = ?",
        )
        .get(CMT) as { n: number }
    ).n;
  }

  beforeEach(() => {
    seedSource("approved_open");
    seedCoverage();
  });

  it("合法指数批次 → 202、index_value 落库、不写快照（spec R3 聚合边界）", async () => {
    const res = await postBatch(idxPayload());
    expect(res.status).toBe(202);
    const b = (await res.json()) as Record<string, unknown>;
    expect(b).toMatchObject({
      observations_written: 1,
      snapshots_upserted: 0,
      duplicates_dropped: 0,
      stale_count: 0,
    });
    const row = ctx.pub
      .prepare(
        "SELECT index_value, quality_status, sample_count FROM price_observations WHERE object_id = ?",
      )
      .get(CMT) as {
      index_value: number;
      quality_status: string;
      sample_count: number;
    };
    expect(row).toMatchObject({
      index_value: 99.5,
      quality_status: "valid",
      sample_count: 0,
    });
    expect(snapshotCount()).toBe(0);
  });

  it("价格类观测携带 index_value → 400 互斥 details（清洗 R1-1）", async () => {
    const res = await postBatch(
      defaultPayload({
        batch_id: "b_04e_idx2",
        observed_count: 1,
        observations: [
          {
            object_id: CMT,
            price_type: "listing_ask",
            metric_code: "listing_ask_unit",
            unit_price_yuan_sqm: 30000,
            index_value: 99.5,
            stat_date: YESTERDAY,
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      details?: Array<{ field: string; message: string }>;
    };
    expect(body.details).toContainEqual(
      expect.objectContaining({ field: "/observations/0/index_value" }),
    );
    expect(obsRowCount()).toBe(0);
  });

  it("official_index 缺 index_value → 400 details（清洗 R1-1）", async () => {
    const res = await postBatch(idxPayload({ index_value: undefined }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      details?: Array<{ field: string; message: string }>;
    };
    expect(body.details).toContainEqual(
      expect.objectContaining({ field: "/observations/0" }),
    );
    expect(obsRowCount()).toBe(0);
  });

  it("index_value=1500 超界 → 400 schema（0<v≤1000）", async () => {
    const res = await postBatch(idxPayload({ index_value: 1500 }));
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation_failed");
    expect(obsRowCount()).toBe(0);
  });

  it("official_index 携带金额字段（unit_price_yuan_sqm）→ 400 互斥 details", async () => {
    const res = await postBatch(
      idxPayload({ unit_price_yuan_sqm: 30000, price_total_fen: 300000000 }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      details?: Array<{ field: string; message: string }>;
    };
    expect(body.details).toContainEqual(
      expect.objectContaining({ field: "/observations/0" }),
    );
    expect(obsRowCount()).toBe(0);
  });
});

describe("computeStats（纯函数直测：线性插值边界）", () => {
  it("奇/偶样本 median、单样本、分位边界", async () => {
    const { computeStats } = await import("./observations");
    expect(computeStats([30000])).toMatchObject({
      median: 30000,
      p25: 30000,
      p75: 30000,
      mean: 30000,
      sample_count: 1,
    });
    // 偶数样本：median = 中间两数均值（numpy linear）
    expect(computeStats([10, 20, 30, 40]).median).toBe(25);
    // p25/p75 插值位置 = (n-1)*p
    const s = computeStats([10, 20, 30, 40]);
    expect(s.p25).toBeCloseTo(17.5, 10);
    expect(s.p75).toBeCloseTo(32.5, 10);
    expect(() => computeStats([])).toThrow();
  });
});

describe("crossSourceDivergence（TASK-09 R3 纯函数直测：双源中位数偏差边界）", () => {
  const rows = (source: string, units: number[]) =>
    units.map((unit_price_yuan_sqm) => ({
      source_id: source,
      unit_price_yuan_sqm,
    }));

  it("有效源≥2：偏差 14.9% → 0.149；15.1% → 0.151（阈值比较由调用方执行）", async () => {
    const { crossSourceDivergence } = await import("./observations");
    const a = rows("s1", [28000, 29000, 30000, 31000, 32000]); // median 30000
    const b149 = rows("s2", [33470, 33970, 34470, 34970, 35470]); // median 34470
    const b151 = rows("s2", [33530, 34030, 34530, 35030, 35530]); // median 34530
    expect(crossSourceDivergence([...a, ...b149])).toBeCloseTo(0.149, 10);
    expect(crossSourceDivergence([...a, ...b151])).toBeCloseTo(0.151, 10);
  });

  it("单源（任意样本量）→ null：交叉核验不触发", async () => {
    const { crossSourceDivergence } = await import("./observations");
    expect(
      crossSourceDivergence(
        rows(
          "s1",
          Array.from({ length: 20 }, () => 30000),
        ),
      ),
    ).toBeNull();
  });

  it("双源但一源样本 < MIN_VALID_SAMPLES(5) → null：非有效源不参与核验", async () => {
    const { crossSourceDivergence } = await import("./observations");
    const a = rows("s1", [28000, 29000, 30000, 31000, 32000]); // 有效源
    const b4 = rows("s2", [33530, 34030, 35030, 35530]); // 4 样本 → 非有效源
    expect(crossSourceDivergence([...a, ...b4])).toBeNull();
  });

  it("三源取最大相对偏差（max−min)/min", async () => {
    const { crossSourceDivergence } = await import("./observations");
    const a = rows("s1", [28000, 29000, 30000, 31000, 32000]); // 30000
    const b = rows("s2", [30000, 31000, 32000, 33000, 34000]); // 32000
    const c = rows("s3", [33000, 34000, 35000, 36000, 37000]); // 35000
    expect(crossSourceDivergence([...a, ...b, ...c])).toBeCloseTo(
      (35000 - 30000) / 30000,
      10,
    );
  });
});

// ===== TASK-05A：系统事件评估端点（签名链 + 幂等） =====
describe("TASK-05A /internal/events/evaluate", () => {
  async function callEvaluate(opts: SignOpts = {}): Promise<Response> {
    const raw = "{}";
    const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
    const nonce = opts.nonce ?? newNonce();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Ingest-Timestamp": ts,
      "X-Ingest-Nonce": nonce,
      "X-Ingest-Signature": await hmacHex(
        opts.secret ?? SECRET,
        `${ts}.${nonce}.${opts.signBody ?? raw}`,
      ),
    };
    return app.request(
      "/api/v1/internal/events/evaluate",
      { method: "POST", headers, body: raw },
      ctx.env,
    );
  }

  it("签名有效 202：延迟+异常各 1 条，复跑幂等，篡改签名 403", async () => {
    const { addDays, shanghaiDate } = await import("./events");
    await seedUser(
      ctx.priv,
      "usr_eval",
      "eval-05a@example.test",
      "tok-eval-05a",
    );
    seedSource("approved_open");
    ctx.pub
      .prepare(
        "INSERT INTO communities (community_id, city_code, name, status) VALUES ('cmt_eval', ?, 'TEST-EVAL小区（虚构）', 'active')",
      )
      .run(CITY);
    // 延迟输入：老快照（30 天 > 默认 SLA 10 天）
    ctx.pub
      .prepare(
        `INSERT INTO price_snapshots
           (snapshot_id, object_type, object_id, price_type, metric_code, median,
            sample_count, stat_date, source_id, quality_status)
         VALUES ('snap_eval_1', 'community', 'cmt_eval', 'listing_ask',
                 'community_ask_median_unit', 20000, 6, ?, ?, 'valid')`,
      )
      .run(addDays(shanghaiDate(new Date()), -30), SOURCE);
    // 异常输入：近 24h 失败任务
    ctx.priv
      .prepare(
        `INSERT INTO ingest_jobs (job_id, source_id, city_code, status, error_code)
         VALUES ('job_eval_fail', ?, ?, 'failed', 'upstream_500')`,
      )
      .run(SOURCE, CITY);
    ctx.priv
      .prepare(
        `INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot)
         VALUES ('w_eval', 'usr_eval', 'community', 'cmt_eval', 'TEST-EVAL小区（虚构）')`,
      )
      .run();

    const first = await callEvaluate();
    expect(first.status).toBe(202);
    const j1 = (await first.json()) as {
      status: string;
      delayed: number;
      anomaly: number;
      skipped: number;
    };
    expect(j1.status).toBe("evaluated");
    expect(j1.delayed).toBe(1);
    expect(j1.anomaly).toBe(1);
    const rows = ctx.priv
      .prepare("SELECT event_type FROM alert_events ORDER BY rowid")
      .all() as unknown as Array<{ event_type: string }>;
    expect(rows.map((r) => r.event_type).sort()).toEqual([
      "data_anomaly",
      "update_delayed",
    ]);

    // 复跑幂等（event_key 含 watch_id/日期/任务）
    const again = await callEvaluate();
    const j2 = (await again.json()) as { delayed: number; anomaly: number };
    expect(j2.delayed).toBe(0);
    expect(j2.anomaly).toBe(0);
    expect(
      (
        ctx.priv.prepare("SELECT COUNT(*) AS n FROM alert_events").get() as {
          n: number;
        }
      ).n,
    ).toBe(2);

    // 篡改签名 → 403
    const bad = await callEvaluate({ signBody: "{}tampered" });
    expect(bad.status).toBe(403);
  });
});

// ===================== TASK-08B T3：§14.2 数据矩阵边界补强 =====================
// 任务书 §14.2 数据矩阵要求：样本数全边界（D4）、组成变化中位数跳变（D6）、
// 同名小区映射冲突（D7）、挂牌价误标成交价（D9）。
// 0/4/5 边界已由既有用例覆盖（04E 过期零样本不写快照、cleaning.test.ts 4→5、
// 04D <5 low_sample），此处只补 1/9/10/19/20 与 D6/D7/D9，不改既有用例。
describe("TASK-08B T3：§14.2 数据矩阵边界补强", () => {
  // 与 04D 同算法：沪市昨日（清洗含未来日期与过期物化判定，固定日期会随时钟失效）
  const STAT_DATE = new Date(Date.now() - 86_400_000 + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);

  /** 与 04D 同型：默认挂牌单价单条 valid 样本；object_id 显式传入，用新名字避免干扰既有用例 */
  function obs(objectId: string, overrides: Record<string, unknown> = {}) {
    return {
      object_id: objectId,
      property_type: "resale",
      price_type: "listing_ask",
      metric_code: "listing_ask_unit",
      price_total_fen: 300000000,
      unit_price_yuan_sqm: 30000,
      area_sqm: 100,
      sample_count: 1,
      stat_date: STAT_DATE,
      quality_status: "valid",
      connector_version: "fang_community/0.1.0",
      ...overrides,
    };
  }

  function obsPayload(
    batchId: string,
    observations: unknown[],
    overrides: Record<string, unknown> = {},
  ) {
    return defaultPayload({
      batch_id: batchId,
      observed_count: observations.length,
      observations,
      ...overrides,
    });
  }

  /** 该对象的全部快照行（行数与字段断言用；按口径排序保证稳定） */
  function snapshotsOf(objectId: string): Array<Record<string, unknown>> {
    return ctx.pub
      .prepare(
        `SELECT price_type, metric_code, median, mean, p25, p75,
                sample_count, stat_date, quality_status, source_id
         FROM price_snapshots WHERE object_id = ?
         ORDER BY price_type, metric_code`,
      )
      .all(objectId) as unknown as Array<Record<string, unknown>>;
  }

  beforeEach(() => {
    seedSource("approved_open");
    seedCoverage();
  });

  it("D4 样本数全边界 1/9/10/19/20：每组一行快照、sample_count=N、5 处质量翻转", async () => {
    // 0/4/5 边界见既有用例：0=无样本不写快照（04E）、4→5 翻转（cleaning.test.ts）、
    // <5 low_sample（04D）；9/10、19/20 是前端分层阈值边界（web market.sampleTier 已测）
    for (const n of [1, 9, 10, 19, 20]) {
      const objectId = `cmt_d4_n${n}`;
      // 批内 unit_price_yuan_sqm 必须互不相同，否则确定性 observation_id 触发批内去重
      const units = Array.from({ length: n }, (_, i) => 20000 + i * 100);
      const res = await postBatch(
        obsPayload(
          `b_t3_d4_n${n}`,
          units.map((u) => obs(objectId, { unit_price_yuan_sqm: u })),
        ),
      );
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        status: "accepted",
        snapshots_upserted: 1,
      });
      const snaps = snapshotsOf(objectId);
      expect(snaps).toHaveLength(1);
      expect(snaps[0]).toMatchObject({
        sample_count: n,
        stat_date: STAT_DATE,
        metric_code: "community_ask_median_unit",
      });
      if (n === 1) {
        // 单样本：low_sample 降级但 median 仍留痕（median = 该单价）
        expect(snaps[0]).toMatchObject({
          quality_status: "low_sample",
          median: units[0],
        });
      } else {
        // n≥5（含 9/10/19/20）→ valid
        expect(snaps[0]?.["quality_status"]).toBe("valid");
      }
    }
  });

  it("D6 组成变化中位数跳变：无阻断规则，快照按组全量诚实重算，中位数稳健均值敏感", async () => {
    const objectId = "cmt_d6_01";
    // 第一批 5 套：基准组 median=30000/mean=30000/sample_count=5
    const first = await postBatch(
      obsPayload(
        "b_t3_d6_a",
        [28000, 29000, 30000, 31000, 32000].map((u) =>
          obs(objectId, { unit_price_yuan_sqm: u }),
        ),
      ),
    );
    expect(first.status).toBe(202);
    expect(snapshotsOf(objectId)).toEqual([
      expect.objectContaining({
        median: 30000,
        mean: 30000,
        sample_count: 5,
        quality_status: "valid",
      }),
    ]);

    // 第二批同对象同 stat_date（不同 batch_id）追加 3 套高价 → 全组重算 n=8
    const second = await postBatch(
      obsPayload(
        "b_t3_d6_b",
        [50000, 52000, 54000].map((u) =>
          obs(objectId, { unit_price_yuan_sqm: u }),
        ),
      ),
    );
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({
      observations_written: 3,
      snapshots_upserted: 1,
    });

    const snaps = snapshotsOf(objectId);
    expect(snaps).toHaveLength(1); // 同组 ON CONFLICT 覆盖重算，不新增行
    expect(snaps[0]).toMatchObject({
      median: 31500, // idx=(8-1)*0.5=3.5 → 31000+0.5×(32000−31000)
      mean: 38250, // 306000/8
      p25: 29750, // idx=1.75 → 29000+0.75×(30000−29000)
      p75: 50500, // idx=5.25 → 50000+0.25×(52000−50000)
      sample_count: 8,
      quality_status: "valid",
    });
    // §14.2-D6 结论：cleaning.ts/observations.ts 均无"组成变化"阻断规则——
    // 快照按组全量重算属"诚实重算"设计：median 30000→31500（+5%，对高价样本稳健），
    // mean 30000→38250（+27.5%，敏感）；sample_count 5→8 留痕样本量变化，
    // 前端以样本量分层（sampleTier）提示可信度，而非改写或阻断历史快照。
  });

  it("D7 同名小区映射：跨来源样本合并为同一行快照；同名不同 object_id 互不污染", async () => {
    const objectId = "cmt_d7_01";
    // 第二个 approved 来源（同城/同层级/同指标覆盖），模拟同名小区经目录映射到同一 canonical object_id
    ctx.pub
      .prepare(
        "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_official_b', 'TEST-官方来源B（虚构）', 'open_data')",
      )
      .run();
    ctx.pub
      .prepare(
        "INSERT INTO source_license_state (source_id, status, valid_until) VALUES ('src_official_b', 'approved_open', NULL)",
      )
      .run();
    ctx.pub
      .prepare(
        `INSERT INTO source_city_coverage
           (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
         VALUES ('src_official_b', ?, 'community', '["community_ask_median_unit"]', 'approved_open', datetime('now'))`,
      )
      .run(CITY);

    // a) 跨来源合并：聚合组键（object_id, price_type, metric_code, stat_date）不含 source_id
    //    → 两来源各 1 条同对象同统计日观测进入同一组，快照仅 1 行、样本合并
    const fromA = await postBatch(
      obsPayload("b_t3_d7_a1", [obs(objectId, { unit_price_yuan_sqm: 30000 })]),
    );
    expect(fromA.status).toBe(202);
    expect(await fromA.json()).toMatchObject({ snapshots_upserted: 1 });
    const fromB = await postBatch(
      obsPayload(
        "b_t3_d7_a2",
        [obs(objectId, { unit_price_yuan_sqm: 34000 })],
        { source_id: "src_official_b" },
      ),
    );
    expect(fromB.status).toBe(202);
    expect(await fromB.json()).toMatchObject({ snapshots_upserted: 1 });
    const merged = snapshotsOf(objectId);
    expect(merged).toHaveLength(1); // 仅一行快照（重算覆盖，非各来源一行）
    expect(merged[0]).toMatchObject({
      sample_count: 2,
      median: 32000, // 两样本线性插值 = 均值 (30000+34000)/2
      quality_status: "low_sample", // 合并后 2 < 5，仍小样本降级
    });

    // b) 同名不同对象：不同区同名小区映射到不同 object_id → 两行独立快照，median 互不污染
    const resA = await postBatch(
      obsPayload("b_t3_d7_b1", [
        obs("cmt_d7_02a", { unit_price_yuan_sqm: 30000 }),
      ]),
    );
    const resB = await postBatch(
      obsPayload("b_t3_d7_b2", [
        obs("cmt_d7_02b", { unit_price_yuan_sqm: 41000 }),
      ]),
    );
    expect(resA.status).toBe(202);
    expect(resB.status).toBe(202);
    expect(snapshotsOf("cmt_d7_02a")).toEqual([
      expect.objectContaining({ median: 30000, sample_count: 1 }),
    ]);
    expect(snapshotsOf("cmt_d7_02b")).toEqual([
      expect.objectContaining({ median: 41000, sample_count: 1 }),
    ]);
  });

  it("D9 挂牌价与成交价隔离：同对象同统计日两口径各自成行；非法 price_type → 400", async () => {
    const objectId = "cmt_d9_01";
    const res = await postBatch(
      obsPayload("b_t3_d9_a", [
        obs(objectId, { unit_price_yuan_sqm: 30000 }),
        obs(objectId, {
          price_type: "closed_transaction",
          metric_code: "closed_tx_unit",
          unit_price_yuan_sqm: 25000,
        }),
      ]),
    );
    // 实测端点行为：closed_transaction 通过 schema 枚举/清洗/DB CHECK，正常受理为独立快照行（非拒绝）
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      observations_written: 2,
      snapshots_upserted: 2,
    });

    const snaps = snapshotsOf(objectId);
    expect(snaps).toHaveLength(2);
    const listing = snaps.find((s) => s["price_type"] === "listing_ask");
    const tx = snaps.find((s) => s["price_type"] === "closed_transaction");
    // 挂牌快照：metric_code 经 OBS_TO_SNAPSHOT_METRIC 映射为 community_ask_median_unit，
    // median=30000 不被成交价 25000 污染（price_type 不同 → 聚合组不同）
    expect(listing).toMatchObject({
      metric_code: "community_ask_median_unit",
      median: 30000,
      sample_count: 1,
    });
    // 成交快照：无映射，metric_code 保留原口径，独立成行
    expect(tx).toMatchObject({
      metric_code: "closed_tx_unit",
      median: 25000,
      sample_count: 1,
    });

    // ingest 侧枚举隔离：口径枚举外的 price_type（如误标 "deal_price"）→ 400 validation_failed 零落库
    const bad = await postBatch(
      obsPayload("b_t3_d9_b", [
        obs(objectId, { price_type: "deal_price", unit_price_yuan_sqm: 26000 }),
      ]),
    );
    expect(bad.status).toBe(400);
    expect(await errCode(bad)).toBe("validation_failed");
    // 拒绝生效：仍只有两行快照，26000 观测零落库
    expect(snapshotsOf(objectId)).toHaveLength(2);
    expect(
      (
        ctx.pub
          .prepare(
            "SELECT COUNT(*) AS n FROM price_observations WHERE unit_price_yuan_sqm = 26000",
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});
