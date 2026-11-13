// TASK-02B：公共查询 API 验收——目录/覆盖/区域/小区/价格/数据源/系统状态，
// 并验证响应不含私有 DB 结构与用户数据（PRD §10.1 / §9.4）。
import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "./app";
import { createTestEnv, type TestContext } from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const PRIVATE_LEAK =
  /sqlite_master|no such table|SELECT\s|PRAGMA|watch_items|watch_rules|alert_events|sessions|email_otps|users|email_normalized|token_hash|user_id/i;

function seedPublic(pub: DatabaseSync): void {
  pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status, catalog_status) VALUES ('C100000', '测试城', 'P110000', 'active', 'active')",
    )
    .run();
  pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status, catalog_status) VALUES ('C200000', '请求城', 'P120000', 'requestable', 'active')",
    )
    .run();
  pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status, catalog_status) VALUES ('C300000', '停用城', 'P130000', 'active', 'disabled')",
    )
    .run();
  pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_demo', '测试来源（虚构）', 'manual')",
    )
    .run();
  pub
    .prepare(
      "INSERT INTO source_city_coverage (source_id, city_code, object_level, authorization_status) VALUES ('src_demo', 'C100000', 'city', 'manual_only')",
    )
    .run();
  pub
    .prepare(
      "INSERT INTO regions (region_id, city_code, name, level) VALUES ('rgn1', 'C100000', '测试区', 'district')",
    )
    .run();
  pub
    .prepare(
      "INSERT INTO communities (community_id, city_code, region_id, name, status) VALUES ('com1', 'C100000', 'rgn1', '测试小区', 'active')",
    )
    .run();
  pub
    .prepare(
      `INSERT INTO price_snapshots (snapshot_id, object_type, object_id, price_type, metric_code, median, sample_count, stat_date, source_id, method_version)
       VALUES ('snap1', 'community', 'com1', 'listing_ask', 'median_unit_price', 20000, 5, '2026-11-01', 'src_demo', '04e-aggregate-v2')`,
    )
    .run();
  pub
    .prepare(
      `INSERT INTO price_snapshots (snapshot_id, object_type, object_id, price_type, metric_code, median, sample_count, stat_date, source_id)
       VALUES ('snap2', 'region', 'rgn1', 'listing_ask', 'median_unit_price', 21000, 8, '2026-11-01', 'src_demo')`,
    )
    .run();
  pub
    .prepare(
      `INSERT INTO price_observations (observation_id, source_id, object_type, object_id, price_type, metric_code, stat_date, payload_hash)
       VALUES ('obs1', 'src_demo', 'community', 'com1', 'listing_ask', 'median_unit_price', '2026-11-01', 'ab12')`,
    )
    .run();
}

beforeEach(() => {
  ctx = createTestEnv();
  seedPublic(ctx.pub);
  app = createApp();
});

describe("公共查询端点", () => {
  it("城市搜索：默认只返回启用目录城市，支持 q/status 过滤", async () => {
    const all = await app.request("/api/v1/public/cities", {}, ctx.env);
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as {
      items: Array<{ city_code: string }>;
    };
    expect(allBody.items.map((c) => c.city_code)).toEqual([
      "C100000",
      "C200000",
    ]);

    const one = await app.request(
      "/api/v1/public/cities?q=测试城",
      {},
      ctx.env,
    );
    const oneBody = (await one.json()) as {
      items: Array<{ city_code: string }>;
    };
    expect(oneBody.items).toHaveLength(1);

    const req = await app.request(
      "/api/v1/public/cities?status=requestable",
      {},
      ctx.env,
    );
    const reqBody = (await req.json()) as {
      items: Array<{ city_code: string }>;
    };
    expect(reqBody.items.map((c) => c.city_code)).toEqual(["C200000"]);
  });

  it("非法 status / limit 返回 400 validation_failed", async () => {
    const res = await app.request(
      "/api/v1/public/cities?status=nonsense",
      {},
      ctx.env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error_code: string;
      details: Array<{ field: string }>;
    };
    expect(body.error_code).toBe("validation_failed");
    expect(body.details[0]?.field).toBe("status");

    const badLimit = await app.request(
      "/api/v1/public/cities?limit=999",
      {},
      ctx.env,
    );
    expect(badLimit.status).toBe(400);
  });

  it("城市覆盖：存在返回城市+覆盖行，不存在 404", async () => {
    const ok = await app.request(
      "/api/v1/public/cities/C100000/coverage",
      {},
      ctx.env,
    );
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as {
      city: { city_code: string };
      coverage: Array<{ source_id: string }>;
    };
    expect(body.city.city_code).toBe("C100000");
    expect(body.coverage[0]?.source_id).toBe("src_demo");

    const missing = await app.request(
      "/api/v1/public/cities/C999999/coverage",
      {},
      ctx.env,
    );
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error_code: string }).error_code).toBe(
      "not_found",
    );
  });

  it("区域搜索与摘要、小区搜索/详情/价格端点可用", async () => {
    const regions = await app.request(
      "/api/v1/public/regions?city_code=C100000",
      {},
      ctx.env,
    );
    const regionsBody = (await regions.json()) as {
      items: Array<{ region_id: string }>;
    };
    expect(regionsBody.items[0]?.region_id).toBe("rgn1");

    const summary = await app.request(
      "/api/v1/public/regions/rgn1/summary",
      {},
      ctx.env,
    );
    const summaryBody = (await summary.json()) as {
      snapshots: Array<{ snapshot_id: string }>;
    };
    expect(summaryBody.snapshots[0]?.snapshot_id).toBe("snap2");

    const communities = await app.request(
      "/api/v1/public/communities?region_id=rgn1&q=测试",
      {},
      ctx.env,
    );
    const comBody = (await communities.json()) as {
      items: Array<{ community_id: string }>;
    };
    expect(comBody.items[0]?.community_id).toBe("com1");

    const detail = await app.request(
      "/api/v1/public/communities/com1",
      {},
      ctx.env,
    );
    expect(detail.status).toBe(200);

    const prices = await app.request(
      "/api/v1/public/communities/com1/prices",
      {},
      ctx.env,
    );
    const priceBody = (await prices.json()) as {
      items: Array<{ median: number }>;
    };
    expect(priceBody.items[0]?.median).toBe(20000);

    const notFound = await app.request(
      "/api/v1/public/communities/com_x",
      {},
      ctx.env,
    );
    expect(notFound.status).toBe(404);
  });

  it("字段验证（TASK-04C）：未验证字段不进 verified_metrics，status 原样返回", async () => {
    ctx.pub
      .prepare(
        `INSERT INTO source_field_verifications (source_id, field_code, field_label, metric_code, status, evidence, verified_at)
         VALUES ('src_demo', 'new_build_yoy_index', '新建商品住宅-本月(上年同月=100)', 'new_house_price_index', 'verified', '2026-09 期样例 99.1', '2026-11-12')`,
      )
      .run();
    ctx.pub
      .prepare(
        `INSERT INTO source_field_verifications (source_id, field_code, field_label, metric_code, status)
         VALUES ('src_demo', 'transaction_price', '成交价字段', 'transaction_price', 'unverified')`,
      )
      .run();
    ctx.pub
      .prepare(
        "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_plain', '无验证行来源（虚构）', 'manual')",
      )
      .run();

    const res = await app.request(
      "/api/v1/public/methodology/sources",
      {},
      ctx.env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        source_id: string;
        field_verifications: Array<{ field_code: string; status: string }>;
        verified_metrics: string[];
      }>;
    };
    const demo = body.items.find((s) => s.source_id === "src_demo");
    expect(demo?.verified_metrics).toEqual(["new_house_price_index"]);
    // unverified 字段（含其指标名）绝不计入已验证指标，且 status 原样返回
    expect(demo?.verified_metrics).not.toContain("transaction_price");
    const unverified = demo?.field_verifications.find(
      (f) => f.field_code === "transaction_price",
    );
    expect(unverified?.status).toBe("unverified");
    const verified = demo?.field_verifications.find(
      (f) => f.field_code === "new_build_yoy_index",
    );
    expect(verified?.status).toBe("verified");
    // 无验证行的来源返回空数组而非缺键
    const plain = body.items.find((s) => s.source_id === "src_plain");
    expect(plain?.field_verifications).toEqual([]);
    expect(plain?.verified_metrics).toEqual([]);
  });

  it("数据源说明与系统状态端点返回公开口径信息", async () => {
    const sources = await app.request(
      "/api/v1/public/methodology/sources",
      {},
      ctx.env,
    );
    const sourceBody = (await sources.json()) as {
      items: Array<{ source_id: string }>;
    };
    expect(sourceBody.items[0]?.source_id).toBe("src_demo");

    const status = await app.request(
      "/api/v1/public/system/status",
      {},
      ctx.env,
    );
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(statusBody.status).toBe("ok");
    expect(statusBody.cities_catalog_active).toBe(2);
    expect(statusBody.last_collected_at).toBeTruthy();
  });
});

describe("隔离验收：公共响应不暴露私有结构", () => {
  it("所有公共端点响应体不含私有表名/SQL/用户字段", async () => {
    const paths = [
      "/api/v1/public/cities",
      "/api/v1/public/cities?status=active",
      "/api/v1/public/cities/C100000/coverage",
      "/api/v1/public/regions?city_code=C100000",
      "/api/v1/public/regions/rgn1/summary",
      "/api/v1/public/communities?region_id=rgn1",
      "/api/v1/public/communities/com1",
      "/api/v1/public/communities/com1/prices",
      "/api/v1/public/communities/coverage?city_code=C100000",
      "/api/v1/public/methodology/sources",
      "/api/v1/public/system/status",
      "/api/v1/public/unknown",
    ];
    for (const path of paths) {
      const res = await app.request(path, {}, ctx.env);
      const text = await res.text();
      expect(PRIVATE_LEAK.test(text), `${path} 泄露内部结构: ${text}`).toBe(
        false,
      );
    }
  });

  it("错误信封只含稳定键，无 SQL/栈信息", async () => {
    const res = await app.request(
      "/api/v1/public/cities/C999999/coverage",
      {},
      ctx.env,
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "error_code",
      "message",
      "request_id",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/SELECT|sqlite|WHERE/i);
  });
});

// ===================== TASK-04D：覆盖结论可复查（spec R3 / SubTask 4.2） =====================

describe("TASK-04D：GET /public/communities/coverage 与验收字段", () => {
  it("逐小区六字段覆盖结论；无快照小区 snapshot:null 不造数；缺 city_code → 400", async () => {
    ctx.pub
      .prepare(
        `INSERT INTO communities (community_id, city_code, region_id, name, status)
         VALUES ('com2', 'C100000', 'rgn1', '无数据小区', 'active')`,
      )
      .run();

    const res = await app.request(
      "/api/v1/public/communities/coverage?city_code=C100000",
      {},
      ctx.env,
    );
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      city_code: string;
      items: Array<{
        community_id: string;
        name: string;
        district: string | null;
        snapshot: Record<string, unknown> | null;
      }>;
      count: number;
    };
    expect(b.city_code).toBe("C100000");
    expect(b.count).toBe(2);

    const com1 = b.items.find((i) => i.community_id === "com1");
    expect(com1?.name).toBe("测试小区");
    expect(com1?.district).toBe("测试区");
    // 验收六字段：source / price_type / sample_count / stat_date / collected_at / quality_status
    expect(com1?.snapshot).toMatchObject({
      source_id: "src_demo",
      price_type: "listing_ask",
      metric_code: "median_unit_price",
      sample_count: 5,
      stat_date: "2026-11-01",
      quality_status: "valid",
    });
    expect(com1?.snapshot?.["collected_at"]).toBeTruthy();

    const com2 = b.items.find((i) => i.community_id === "com2");
    expect(com2?.snapshot).toBeNull();

    const missing = await app.request(
      "/api/v1/public/communities/coverage",
      {},
      ctx.env,
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error_code: string }).error_code).toBe(
      "validation_failed",
    );
  });

  it("prices 端点返回 collected_at 与 method_version（口径版本化，spec R2）", async () => {
    const res = await app.request(
      "/api/v1/public/communities/com1/prices",
      {},
      ctx.env,
    );
    const b = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(b.items[0]?.["median"]).toBe(20000);
    expect(b.items[0]?.["collected_at"]).toBeTruthy();
    expect(b.items[0]?.["method_version"]).toBe("04e-aggregate-v2");
  });
});
