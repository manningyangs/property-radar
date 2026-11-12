// TASK-02B：公共查询 API（PRD §10.1）——只读 Public DB，响应绝不含用户数据。
import { Hono } from "hono";
import { CITY_STATUSES } from "@property-radar/shared";
import { errors } from "../errors";
import { type AppEnv } from "../env";

export const publicRoutes = new Hono<AppEnv>();

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

/** 读取分页 limit：非法值 → 400，超限截断 */
function readLimit(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw errors.validation([
      { field: "limit", message: `必须是 1-${MAX_LIMIT} 的整数` },
    ]);
  }
  return n;
}

/** 读取可选枚举参数 */
function readEnum(
  raw: string | undefined,
  field: string,
  allowed: readonly string[],
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!allowed.includes(raw)) {
    throw errors.validation([
      { field, message: `取值必须是 ${allowed.join(", ")} 之一` },
    ]);
  }
  return raw;
}

/** 搜索词：去空白并截断，防止超长 LIKE */
function readQuery(raw: string | undefined): string {
  return (raw ?? "").trim().slice(0, 64);
}

interface CityRow {
  city_code: string;
  name: string;
  province_code: string;
  status: string;
  catalog_status: string;
  coverage_level: string | null;
  coverage_note: string | null;
  updated_at: string;
}

// GET /public/cities?q=&status= —— 城市目录搜索与覆盖状态
publicRoutes.get("/cities", async (c) => {
  const q = readQuery(c.req.query("q"));
  const status = readEnum(c.req.query("status"), "status", CITY_STATUSES);
  const limit = readLimit(c.req.query("limit"));
  const where: string[] = ["catalog_status = 'active'"];
  const params: Array<string | number> = [];
  if (q) {
    where.push("(name LIKE ? OR city_code = ?)");
    params.push(`%${q}%`, q);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  params.push(limit);
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT city_code, name, province_code, status, catalog_status,
            coverage_level, coverage_note, updated_at
     FROM cities
     WHERE ${where.join(" AND ")}
     ORDER BY name
     LIMIT ?`,
  )
    .bind(...params)
    .all<CityRow>();
  return c.json({ items: res.results, count: res.results.length });
});

// GET /public/cities/:cityCode/coverage —— 城市级覆盖、更新时间与指标口径
publicRoutes.get("/cities/:cityCode/coverage", async (c) => {
  const cityCode = c.req.param("cityCode");
  const city = await c.env.DB_PUBLIC.prepare(
    `SELECT city_code, name, province_code, status, catalog_status,
            coverage_level, coverage_note, updated_at
     FROM cities WHERE city_code = ?`,
  )
    .bind(cityCode)
    .first<CityRow>();
  if (!city) throw errors.notFound("城市不存在");
  const coverage = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id, object_level, metric_codes_json, authorization_status, last_verified_at
     FROM source_city_coverage
     WHERE city_code = ?
     ORDER BY source_id`,
  )
    .bind(cityCode)
    .all();
  return c.json({
    city,
    coverage: coverage.results,
    updated_at: city.updated_at,
  });
});

// GET /public/regions?city_code=&q= —— 行政区域搜索
publicRoutes.get("/regions", async (c) => {
  const cityCode = readQuery(c.req.query("city_code"));
  const q = readQuery(c.req.query("q"));
  const limit = readLimit(c.req.query("limit"));
  const where: string[] = ["is_active = 1"];
  const params: Array<string | number> = [];
  if (cityCode) {
    where.push("city_code = ?");
    params.push(cityCode);
  }
  if (q) {
    where.push("name LIKE ?");
    params.push(`%${q}%`);
  }
  params.push(limit);
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT region_id, parent_id, city_code, region_code, name, level, is_active, updated_at
     FROM regions
     WHERE ${where.join(" AND ")}
     ORDER BY name
     LIMIT ?`,
  )
    .bind(...params)
    .all();
  return c.json({ items: res.results, count: res.results.length });
});

// GET /public/regions/:id/summary —— 区域最新指标（最新快照）
publicRoutes.get("/regions/:id/summary", async (c) => {
  const regionId = c.req.param("id");
  const region = await c.env.DB_PUBLIC.prepare(
    `SELECT region_id, parent_id, city_code, name, level, updated_at
     FROM regions WHERE region_id = ?`,
  )
    .bind(regionId)
    .first();
  if (!region) throw errors.notFound("区域不存在");
  const snapshots = await c.env.DB_PUBLIC.prepare(
    `SELECT snapshot_id, price_type, metric_code, median, mean, p25, p75,
            sample_count, stat_date, quality_status
     FROM price_snapshots
     WHERE object_type = 'region' AND object_id = ?
     ORDER BY stat_date DESC, metric_code
     LIMIT 20`,
  )
    .bind(regionId)
    .all();
  return c.json({ region, snapshots: snapshots.results });
});

// GET /public/communities?region_id=&q= —— 小区搜索
publicRoutes.get("/communities", async (c) => {
  const regionId = readQuery(c.req.query("region_id"));
  const q = readQuery(c.req.query("q"));
  const limit = readLimit(c.req.query("limit"));
  const where: string[] = ["status = 'active'"];
  const params: Array<string | number> = [];
  if (regionId) {
    where.push("region_id = ?");
    params.push(regionId);
  }
  if (q) {
    where.push("name LIKE ?");
    params.push(`%${q}%`);
  }
  params.push(limit);
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT community_id, city_code, region_id, name, block_name, built_year, status, updated_at
     FROM communities
     WHERE ${where.join(" AND ")}
     ORDER BY name
     LIMIT ?`,
  )
    .bind(...params)
    .all();
  return c.json({ items: res.results, count: res.results.length });
});

// GET /public/communities/coverage?city_code= —— TASK-04D：逐小区覆盖结论（spec R3 / 验收"覆盖可复查"）
// 逐小区返回 {community_id, name, district, snapshot: 最新快照六字段 | null}——无快照如实 null，不造数。
// 注册须先于 /communities/:id，否则 "coverage" 会被当作小区 ID。
publicRoutes.get("/communities/coverage", async (c) => {
  const cityCode = (c.req.query("city_code") ?? "").trim();
  if (!cityCode) {
    throw errors.validation([
      { field: "city_code", message: "city_code 不能为空" },
    ]);
  }
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT c.community_id, c.name, r.name AS district,
            s.source_id, s.price_type, s.metric_code, s.sample_count,
            s.stat_date, s.collected_at, s.quality_status
     FROM communities c
     LEFT JOIN regions r ON r.region_id = c.region_id
     LEFT JOIN price_snapshots s ON s.snapshot_id = (
       SELECT s2.snapshot_id FROM price_snapshots s2
       WHERE s2.object_type = 'community' AND s2.object_id = c.community_id
       ORDER BY s2.stat_date DESC, s2.metric_code
       LIMIT 1
     )
     WHERE c.city_code = ? AND c.status = 'active'
     ORDER BY c.name
     LIMIT 200`,
  )
    .bind(cityCode)
    .all<{
      community_id: string;
      name: string;
      district: string | null;
      source_id: string | null;
      price_type: string | null;
      metric_code: string | null;
      sample_count: number | null;
      stat_date: string | null;
      collected_at: string | null;
      quality_status: string | null;
    }>();
  const items = res.results.map((row) => ({
    community_id: row.community_id,
    name: row.name,
    district: row.district,
    snapshot:
      row.source_id === null
        ? null
        : {
            source_id: row.source_id,
            price_type: row.price_type,
            metric_code: row.metric_code,
            sample_count: row.sample_count,
            stat_date: row.stat_date,
            collected_at: row.collected_at,
            quality_status: row.quality_status,
          },
  }));
  return c.json({
    city_code: cityCode,
    items,
    count: items.length,
  });
});

// GET /public/communities/:id —— 小区基础信息
publicRoutes.get("/communities/:id", async (c) => {
  const row = await c.env.DB_PUBLIC.prepare(
    `SELECT community_id, city_code, region_id, name, alias_json, address_coarse,
            block_name, built_year, longitude, latitude, status, updated_at
     FROM communities WHERE community_id = ?`,
  )
    .bind(c.req.param("id"))
    .first();
  if (!row) throw errors.notFound("小区不存在");
  return c.json({ community: row });
});

// GET /public/communities/:id/prices —— 小区价格快照与历史
publicRoutes.get("/communities/:id/prices", async (c) => {
  const communityId = c.req.param("id");
  const exists = await c.env.DB_PUBLIC.prepare(
    "SELECT community_id FROM communities WHERE community_id = ?",
  )
    .bind(communityId)
    .first();
  if (!exists) throw errors.notFound("小区不存在");
  const limit = readLimit(c.req.query("limit"));
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT snapshot_id, price_type, metric_code, median, mean, p25, p75,
            sample_count, stat_date, quality_status, source_id, collected_at
     FROM price_snapshots
     WHERE object_type = 'community' AND object_id = ?
     ORDER BY stat_date DESC, metric_code
     LIMIT ?`,
  )
    .bind(communityId, limit)
    .all();
  return c.json({ items: res.results, count: res.results.length });
});

// GET /public/methodology/sources —— 可公开的数据源说明（无合同/密钥字段）
// TASK-04A：附许可状态与到期日（LEFT JOIN，缺行按 discovered）；不暴露审批私有材料。
// TASK-04C：附逐字段验证状态（field_verifications 原样含 status）与 verified_metrics——
// 仅 status='verified' 且 metric_code 非空的字段计入已验证指标，未验证字段绝不展示为已验证。
publicRoutes.get("/methodology/sources", async (c) => {
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT p.source_id, p.name, p.source_type, p.official_url, p.data_scope,
            p.license_note_url, p.display_scope, p.updated_at, p.last_verified_at,
            COALESCE(s.status, 'discovered') AS license_status,
            s.valid_until AS license_valid_until
     FROM data_sources_public p
     LEFT JOIN source_license_state s ON s.source_id = p.source_id
     ORDER BY p.name
     LIMIT 100`,
  ).all<{
    source_id: string;
    name: string;
    source_type: string;
    official_url: string | null;
    data_scope: string | null;
    license_note_url: string | null;
    display_scope: string | null;
    updated_at: string;
    last_verified_at: string | null;
    license_status: string;
    license_valid_until: string | null;
  }>();
  const ver = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id, field_code, field_label, metric_code, status, evidence, verified_at
     FROM source_field_verifications
     ORDER BY source_id, field_code`,
  ).all<{
    source_id: string;
    field_code: string;
    field_label: string;
    metric_code: string | null;
    status: string;
    evidence: string | null;
    verified_at: string | null;
  }>();
  const bySource = new Map<
    string,
    Array<{
      field_code: string;
      field_label: string;
      metric_code: string | null;
      status: string;
      evidence: string | null;
      verified_at: string | null;
    }>
  >();
  for (const row of ver.results) {
    const list = bySource.get(row.source_id) ?? [];
    list.push(row);
    bySource.set(row.source_id, list);
  }
  const items = res.results.map((src) => {
    const field_verifications = bySource.get(src.source_id) ?? [];
    const verified_metrics = [
      ...new Set(
        field_verifications
          .filter((f) => f.status === "verified" && f.metric_code)
          .map((f) => f.metric_code as string),
      ),
    ];
    return { ...src, field_verifications, verified_metrics };
  });
  return c.json({ items, count: items.length });
});

// GET /public/system/status —— 数据更新时间与覆盖状态
publicRoutes.get("/system/status", async (c) => {
  const row = await c.env.DB_PUBLIC.prepare(
    `SELECT
       (SELECT COUNT(*) FROM cities WHERE catalog_status = 'active') AS cities_catalog_active,
       (SELECT COUNT(*) FROM cities WHERE status = 'active') AS cities_data_active,
       (SELECT COUNT(*) FROM data_sources_public) AS sources_total,
       (SELECT MAX(collected_at) FROM price_observations) AS last_collected_at,
       (SELECT COUNT(*) FROM price_observations) AS observations_total`,
  ).first();
  return c.json({
    status: "ok",
    ...(row ?? {}),
    checked_at: new Date().toISOString(),
  });
});
