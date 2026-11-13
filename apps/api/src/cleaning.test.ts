// TASK-04E：清洗模块与确定性 ID 口径（spec R1/R2/R3）
// SubTask 2.2：既有价格观测 payload_hash/observation_id 稳定——canonical 仅在 index_value
// 非空时追加入键（末尾追加保键序），04D 既有的价格观测哈希必须逐字节不变（ON CONFLICT 幂等延续）。
// SubTask 4.1（Task 4）：六类清洗规则 fixture——R4 表逐行断言（重复/缺字段/极端价格/
// 日期倒退/样本不足/过期），经完整路由 harness 提交批次，400 必须零行、202 必须留痕。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { observationIds, type ObservationInput } from "./observations";
import { createTestEnv, type TestContext } from "./test-utils/setup";

/** 04D 既有价格观测样例（无 index_value）——哈希基线取自 04D 口径实算 */
const PRICE_OBS: ObservationInput = {
  object_id: "cmt_qd_01",
  property_type: "resale",
  price_type: "listing_ask",
  metric_code: "listing_ask_unit",
  price_total_fen: 300000000,
  unit_price_yuan_sqm: 30000,
  area_sqm: 100,
  sample_count: 1,
  stat_date: "2026-11-12",
  quality_status: "valid",
  connector_version: "fang_community/0.1.0",
};

/** 04E 指数观测样例（index_value 非空 → canonical 末尾携键） */
const INDEX_OBS: ObservationInput = {
  object_id: "cmt_qd_01",
  property_type: null,
  price_type: "official_index",
  metric_code: "new_house_price_index",
  price_total_fen: null,
  unit_price_yuan_sqm: null,
  area_sqm: null,
  sample_count: 0,
  stat_date: "2026-11-12",
  quality_status: "valid",
  connector_version: null,
  index_value: 99.5,
};

describe("确定性观测 ID（04D → 04E 兼容，spec R3 canonical 条件键）", () => {
  it("既有价格观测（无 index_value）payload_hash / observation_id 与 04D 完全一致", async () => {
    const { observationId, payloadHash } = await observationIds(
      "src_official",
      PRICE_OBS,
    );
    expect(payloadHash).toBe(
      "fa0ec7632a4a4e722e0bb0b46da92109b94c3c623e0665365d4b743e00d99260",
    );
    expect(observationId).toBe("9b0a2a1e78624f1bbd2d0e09a1209ad5");
  });

  it("指数观测 canonical 携 index_value（末尾追加），ID 确定可复算", async () => {
    const { observationId, payloadHash } = await observationIds(
      "src_official",
      INDEX_OBS,
    );
    expect(payloadHash).toBe(
      "a4d8ec27b75971983aec8ab63a352da63d00578f2c853b2b02ab357ee67f3230",
    );
    expect(observationId).toBe("517806dc726b04cb5e6dc0ea98580f88");
  });

  it("index_value 显式 null 与缺省同 ID（价格口径不漂移）", async () => {
    const withNull = await observationIds("src_official", {
      ...PRICE_OBS,
      index_value: null,
    });
    const noKey = await observationIds("src_official", PRICE_OBS);
    expect(withNull.payloadHash).toBe(noKey.payloadHash);
    expect(withNull.observationId).toBe(noKey.observationId);
  });
});

// ===================== TASK-04E SubTask 4.1：六类清洗规则 fixture（spec §2 R4 表） =====================
// 自包含路由 harness（与 internal.test.ts 同构）：HMAC 签名批次 → 清洗规则先行 →
// 400 零行（拍板 1 details 留痕）/ 202 计数留痕。逐行断言对齐 R4 表六行。

const FIX_SECRET = "test-ingest-secret-04e-fixture";
const FIX_CITY = "TEST-0001";
const FIX_SOURCE = "src_official";
const FIX_CMT = "cmt_fix_01";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

/** 沪市日期（与清洗模块 shanghaiDate 同口径：UTC+8 平移取日） */
const shDate = (ms: number) =>
  new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
const TODAY = shDate(Date.now());
const YESTERDAY = shDate(Date.now() - 86_400_000);
const daysAgo = (n: number) => shDate(Date.now() - n * 86_400_000);

function seedCity(): void {
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status) VALUES (?, 'TEST-城市', 'TEST-P', 'active')",
    )
    .run(FIX_CITY);
}

function seedSource(): void {
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, 'TEST-官方来源（虚构）', 'open_data')",
    )
    .run(FIX_SOURCE);
  ctx.pub
    .prepare(
      "INSERT INTO source_license_state (source_id, status, valid_until) VALUES (?, 'approved_open', NULL)",
    )
    .run(FIX_SOURCE);
  ctx.pub
    .prepare(
      `INSERT INTO source_city_coverage
         (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
       VALUES (?, ?, 'community', '["community_ask_median_unit"]', 'approved_open', datetime('now'))`,
    )
    .run(FIX_SOURCE, FIX_CITY);
}

/** R4-4 prices 端点断言需小区行在册（否则 404） */
function seedCommunity(): void {
  ctx.pub
    .prepare(
      "INSERT INTO communities (community_id, city_code, name, status) VALUES (?, ?, '清洗测试小区', 'active')",
    )
    .run(FIX_CMT, FIX_CITY);
}

/** HMAC-SHA256 → 小写 hex（runtime 口径：`${ts}.${nonce}.${body}`） */
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

function defaultPayload(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: "b_r4_000",
    source_id: FIX_SOURCE,
    city_code: FIX_CITY,
    object_level: "community",
    observed_count: 0,
    ...overrides,
  };
}

async function postBatch(payload: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Ingest-Timestamp": ts,
    "X-Ingest-Nonce": nonce,
    "X-Ingest-Signature": await hmacHex(FIX_SECRET, `${ts}.${nonce}.${raw}`),
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

describe("TASK-04E SubTask 4.1：六类清洗规则 fixture（spec §2 R4 表逐行断言）", () => {
  function obs(overrides: Record<string, unknown> = {}) {
    return {
      object_id: FIX_CMT,
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

  beforeEach(() => {
    ctx = createTestEnv();
    app = createApp();
    ctx.env.INGEST_HMAC_SECRET = FIX_SECRET;
    seedCity();
    seedSource();
  });

  // ---- R4 行 1：重复 ----
  it("重复：批内 ×2 → 1 行 + duplicates_dropped=1；跨批重提行数不变、payload_hash 稳定", async () => {
    const one = obs({ unit_price_yuan_sqm: 27000, area_sqm: 88 });
    const first = await postBatch(
      obsPayload([one, { ...one }], { batch_id: "b_r4_dup_a" }),
    );
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      observations_written: 1,
      snapshots_upserted: 1,
      duplicates_dropped: 1,
      stale_count: 0,
    });
    expect(obsRowCount()).toBe(1);

    const readIds = () =>
      (
        ctx.pub
          .prepare(
            "SELECT observation_id, payload_hash FROM price_observations ORDER BY observation_id",
          )
          .all() as Array<{ observation_id: string; payload_hash: string }>
      ).map((r) => `${r.observation_id}:${r.payload_hash}`);
    const hashBefore = readIds();

    // 跨批（不同 batch_id）重提同观测 → 04D ON CONFLICT 幂等：行数不变、哈希稳定
    const second = await postBatch(
      obsPayload([one], { batch_id: "b_r4_dup_b" }),
    );
    expect(second.status).toBe(202);
    expect(obsRowCount()).toBe(1);
    const hashAfter = readIds();
    expect(hashAfter).toEqual(hashBefore);
    expect(hashAfter[0]).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
  });

  // ---- R4 行 2：缺字段 ----
  it("缺字段：缺 stat_date / 双价皆空 / area≤0 / 指数无 index_value → 全 400 字段级 details 零行", async () => {
    const noDate = obs({ stat_date: undefined });
    const noPrices = obs({ price_total_fen: null, unit_price_yuan_sqm: null });
    const badArea = obs({ area_sqm: 0 });
    const idxNoValue = {
      object_id: FIX_CMT,
      price_type: "official_index",
      metric_code: "new_house_price_index",
      sample_count: 0,
      stat_date: YESTERDAY,
      quality_status: "valid",
    };

    // 缺 stat_date（schema required）→ 字段级 details 指回条目并点名字段
    const r1 = await postBatch(
      obsPayload([noDate], { batch_id: "b_r4_miss_1" }),
    );
    expect(r1.status).toBe(400);
    expect(await detailsOf(r1)).toContainEqual(
      expect.objectContaining({
        field: "/observations/0",
        message: expect.stringContaining("stat_date"),
      }),
    );

    // 双价皆空（语义规则 1）→ 条目级 details
    const r2 = await postBatch(
      obsPayload([noPrices], { batch_id: "b_r4_miss_2" }),
    );
    expect(r2.status).toBe(400);
    expect(await detailsOf(r2)).toContainEqual(
      expect.objectContaining({ field: "/observations/0" }),
    );

    // area ≤ 0 → 字段路径
    const r3 = await postBatch(
      obsPayload([badArea], { batch_id: "b_r4_miss_3" }),
    );
    expect(r3.status).toBe(400);
    expect(await detailsOf(r3)).toContainEqual(
      expect.objectContaining({ field: "/observations/0/area_sqm" }),
    );

    // 指数无 index_value → 条目级 details 点名 index_value
    const r4 = await postBatch(
      obsPayload([idxNoValue], { batch_id: "b_r4_miss_4" }),
    );
    expect(r4.status).toBe(400);
    expect(await detailsOf(r4)).toContainEqual(
      expect.objectContaining({
        field: "/observations/0",
        message: expect.stringContaining("index_value"),
      }),
    );

    // 四例任一：批次零受理、观测零落库（拍板 1）
    expect(batchCount()).toBe(0);
    expect(obsRowCount()).toBe(0);
  });

  // ---- R4 行 3：极端价格 ----
  it("极端价格：单价 999999 元/㎡、总价 2 亿元 → 400 details，零受理零落库", async () => {
    const res = await postBatch(
      obsPayload(
        [
          obs({ unit_price_yuan_sqm: 999999 }),
          obs({ price_total_fen: 20_000_000_000, unit_price_yuan_sqm: 20000 }),
        ],
        { batch_id: "b_r4_extreme" },
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

  // ---- R4 行 4：日期倒退 ----
  it("日期倒退：先提 T 再提 T−5 → 旧行入历史、最新快照与 prices 首条仍 T；T+1 → 400", async () => {
    seedCommunity();

    // T（沪市当日，允许）先行
    const first = await postBatch(
      obsPayload([obs({ stat_date: TODAY, unit_price_yuan_sqm: 30000 })], {
        batch_id: "b_r4_date_a",
      }),
    );
    expect(first.status).toBe(202);

    // T−5 倒退回历史（不拒绝，拍板 3）
    const back = daysAgo(5);
    const second = await postBatch(
      obsPayload([obs({ stat_date: back, unit_price_yuan_sqm: 29000 })], {
        batch_id: "b_r4_date_b",
      }),
    );
    expect(second.status).toBe(202);

    // 旧行入历史：观测 2 行并存
    expect(obsRowCount()).toBe(2);

    // 快照按 stat_date 分组并存，最新仍为 T（倒退不覆盖新快照）
    const snaps = (
      ctx.pub
        .prepare(
          "SELECT stat_date FROM price_snapshots WHERE object_id = ? ORDER BY stat_date DESC",
        )
        .all(FIX_CMT) as Array<{ stat_date: string }>
    ).map((r) => r.stat_date);
    expect(snaps).toEqual([TODAY, back]);

    // prices 端点 ORDER BY stat_date DESC → 首条 = T
    const prices = await app.request(
      `/api/v1/public/communities/${FIX_CMT}/prices`,
      {},
      ctx.env,
    );
    expect(prices.status).toBe(200);
    const body = (await prices.json()) as {
      items: Array<{ stat_date: string }>;
    };
    expect(body.items[0]?.stat_date).toBe(TODAY);

    // T+1 → 400 未来日期 details（造假防护）
    const future = await postBatch(
      obsPayload([obs({ stat_date: shDate(Date.now() + 86_400_000) })], {
        batch_id: "b_r4_date_c",
      }),
    );
    expect(future.status).toBe(400);
    expect(await detailsOf(future)).toContainEqual(
      expect.objectContaining({ field: "/observations/0/stat_date" }),
    );
    expect(obsRowCount()).toBe(2); // 400 不落库
  });

  // ---- R4 行 5：样本不足 ----
  it("样本不足：4 套 → low_sample 且 median 留痕；补第 5 套 → valid", async () => {
    const four = [28000, 29000, 30000, 31000];
    const first = await postBatch(
      obsPayload(
        four.map((u) => obs({ unit_price_yuan_sqm: u, area_sqm: 90 })),
        { batch_id: "b_r4_samp_a" },
      ),
    );
    expect(first.status).toBe(202);
    let snap = ctx.pub
      .prepare(
        "SELECT sample_count, quality_status, median FROM price_snapshots WHERE object_id = ?",
      )
      .get(FIX_CMT) as Record<string, unknown>;
    expect(snap).toMatchObject({
      sample_count: 4,
      quality_status: "low_sample",
      median: 29500, // 4 样本 linear 插值 median 仍算（不静默删除）
    });

    // 补第 5 套 → 跨过 MIN_VALID_SAMPLES=5 → valid
    const second = await postBatch(
      obsPayload([obs({ unit_price_yuan_sqm: 32000, area_sqm: 91 })], {
        batch_id: "b_r4_samp_b",
      }),
    );
    expect(second.status).toBe(202);
    snap = ctx.pub
      .prepare(
        "SELECT sample_count, quality_status, median FROM price_snapshots WHERE object_id = ?",
      )
      .get(FIX_CMT) as Record<string, unknown>;
    expect(snap).toMatchObject({
      sample_count: 5,
      quality_status: "valid",
      median: 30000, // [28000..32000] 中位
    });
  });

  // ---- R4 行 6：过期 ----
  it("过期：T−40 → stale 物化 + snapshots_upserted=0；阈值内 T−25 对照 → valid 且聚合", async () => {
    const old = await postBatch(
      obsPayload([obs({ stat_date: daysAgo(40) })], {
        batch_id: "b_r4_stale_a",
      }),
    );
    expect(old.status).toBe(202);
    expect(await old.json()).toMatchObject({
      observations_written: 1,
      snapshots_upserted: 0,
      duplicates_dropped: 0,
      stale_count: 1,
    });
    const oldRow = ctx.pub
      .prepare(
        "SELECT quality_status FROM price_observations WHERE object_id = ? AND stat_date = ?",
      )
      .get(FIX_CMT, daysAgo(40)) as { quality_status: string };
    expect(oldRow.quality_status).toBe("stale");
    // 过期组无 valid 样本 → 不写快照（不造数）
    const snapCount = ctx.pub
      .prepare("SELECT COUNT(*) AS n FROM price_snapshots WHERE object_id = ?")
      .get(FIX_CMT) as { n: number };
    expect(snapCount.n).toBe(0);
    expect(batchCount()).toBe(1); // 过期照常受理（拍板 2）

    // 阈值内对照组（T−25 < 30 天默认阈值）→ valid 且聚合入快照
    const fresh = await postBatch(
      obsPayload(
        [obs({ stat_date: daysAgo(25), unit_price_yuan_sqm: 29500 })],
        { batch_id: "b_r4_stale_b" },
      ),
    );
    expect(fresh.status).toBe(202);
    expect(await fresh.json()).toMatchObject({
      observations_written: 1,
      snapshots_upserted: 1,
      duplicates_dropped: 0,
      stale_count: 0,
    });
    const freshRow = ctx.pub
      .prepare(
        "SELECT quality_status FROM price_observations WHERE object_id = ? AND stat_date = ?",
      )
      .get(FIX_CMT, daysAgo(25)) as { quality_status: string };
    expect(freshRow.quality_status).toBe("valid");
    const freshSnap = ctx.pub
      .prepare(
        "SELECT quality_status, sample_count FROM price_snapshots WHERE object_id = ? AND stat_date = ?",
      )
      .get(FIX_CMT, daysAgo(25)) as Record<string, unknown>;
    expect(freshSnap).toMatchObject({ sample_count: 1 });
    expect(batchCount()).toBe(2);
  });
});
