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
    expect(snap["method_version"]).toBe("04e-aggregate-v2");
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
