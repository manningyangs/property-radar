// TASK-04D：价格观测落库与快照聚合（spec R2；PRD §9.1 price_observations / price_snapshots、§4.4）
// internal 批次与 admin 手工补录共用同一模块，保证口径一致：
//   1) payload_hash = SHA-256(观测字段规范化 JSON)；observation_id = SHA-256(
//      `source_id|object_type|object_id|price_type|metric_code|stat_date|payload_hash`) 前 32 hex——
//      确定性 ID + ON CONFLICT DO UPDATE，同一观测重复提交幂等不产生重复行；
//   2) 落库后按（对象, 价格类型, 快照指标, 统计日）全量重算聚合：median/mean/p25/p75
//      用线性插值（numpy 默认口径，实现于纯函数 computeStats，供测试直测）；
//   3) 快照 sample_count >= 5 → valid，否则 low_sample（PRD §4.4 小样本降级，
//      median 等仍计算留痕，不静默删除）；无可聚合样本时不写快照（不造数）；
//   4) object_type 一律 community（04D 无独立 listing 实体，样本挂在小区对象下）；
//   5) TASK-09 R3 双源交叉核验：同组有效源（单源 valid 单价样本 ≥5）≥2 且各源中位数
//      最大相对偏差 > CROSS_SOURCE_MAX_DIVERGENCE（15%，负责人 2026-11-17 裁决）
//      → 快照 quality_status='outlier'（仍计算留痕不隐藏），进后台质量异常。
import { sha256Hex } from "./auth";
import {
  CROSS_SOURCE_MAX_DIVERGENCE,
  METHOD_VERSION,
  MIN_VALID_SAMPLES,
  OBS_TO_SNAPSHOT_METRIC,
} from "./cleaning";
import type { Env } from "./env";

/** 观测对象层级（spec R2：04D 样本统一挂小区） */
export const OBJECT_TYPE = "community";

/** 单条观测输入（schema 见 schemas.ts OBSERVATION_ITEM_SCHEMA，字段口径与其一致） */
export interface ObservationInput {
  object_id: string;
  property_type?: "new_build" | "resale" | null;
  price_type: string;
  metric_code: string;
  price_total_fen?: number | null;
  unit_price_yuan_sqm?: number | null;
  area_sqm?: number | null;
  sample_count?: number;
  stat_date: string;
  quality_status?: string;
  connector_version?: string | null;
  /** TASK-04E：指数口径值（0<v≤1000，仅 official_index 携带；列与 schema 随 0004 迁移就位） */
  index_value?: number | null;
}

export interface WriteResult {
  observations_written: number;
  snapshots_upserted: number;
  observation_ids: string[];
}

interface Stats {
  median: number;
  mean: number;
  p25: number;
  p75: number;
  sample_count: number;
}

/** 线性插值分位数（numpy.percentile 默认 linear 口径）：idx = (n-1)*p */
function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] as number;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi] as number;
  return loVal + (idx - lo) * (hiVal - loVal);
}

/** 聚合统计（纯函数，供单测直测）：空样本抛错（调用方先判空，不造数） */
export function computeStats(values: number[]): Stats {
  if (values.length === 0) {
    throw new Error("computeStats 需要至少一个样本");
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    median: percentile(sorted, 0.5),
    mean: sum / sorted.length,
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    sample_count: sorted.length,
  };
}

/**
 * 双源交叉核验（TASK-09 R3，纯函数供单测直测）：按 source_id 分组取各源中位数，
 * "有效源" = 组内 valid 单价样本 ≥ MIN_VALID_SAMPLES 的来源；有效源 ≥ 2 时返回
 * 各源中位数最大相对偏差 (max−min)/min，否则返回 null（单源/样本不足不触发核验）。
 * 与 low_sample 天然互斥：触发核验需 ≥2×5=10 样本，快照总样本必 ≥ MIN_VALID_SAMPLES。
 */
export function crossSourceDivergence(
  rows: Array<{ source_id: string; unit_price_yuan_sqm: number }>,
): number | null {
  const bySource = new Map<string, number[]>();
  for (const r of rows) {
    const list = bySource.get(r.source_id) ?? [];
    list.push(r.unit_price_yuan_sqm);
    bySource.set(r.source_id, list);
  }
  const medians: number[] = [];
  for (const values of bySource.values()) {
    if (values.length < MIN_VALID_SAMPLES) continue; // 非有效源不参与核验
    medians.push(computeStats(values).median);
  }
  if (medians.length < 2) return null;
  const min = Math.min(...medians);
  const max = Math.max(...medians);
  if (min <= 0) return null; // 防御：非正中位数无法定义相对偏差（价格口径不可能出现）
  return (max - min) / min;
}

/** 观测字段规范化 JSON（固定键序，跨运行/跨语言稳定 → payload_hash 稳定） */
function canonicalObservation(o: ObservationInput): string {
  const base = {
    object_type: OBJECT_TYPE,
    object_id: o.object_id,
    property_type: o.property_type ?? null,
    price_type: o.price_type,
    metric_code: o.metric_code,
    price_total_fen: o.price_total_fen ?? null,
    unit_price_yuan_sqm: o.unit_price_yuan_sqm ?? null,
    area_sqm: o.area_sqm ?? null,
    sample_count: o.sample_count ?? 1,
    stat_date: o.stat_date,
    quality_status: o.quality_status ?? "valid",
    connector_version: o.connector_version ?? null,
  };
  // TASK-04E：index_value 仅在非空时追加入键（末尾追加保既有键序）——既有价格观测的
  // canonical 字符串不变 → payload_hash/observation_id 稳定（04D 幂等延续）；
  // 指数观测携键，与 Python canonicalize 条件键口径一致（spec R3）。
  return JSON.stringify(
    o.index_value == null ? base : { ...base, index_value: o.index_value },
  );
}

/** 确定性 observation_id（前 32 hex）与 payload_hash */
export async function observationIds(
  sourceId: string,
  o: ObservationInput,
): Promise<{ observationId: string; payloadHash: string }> {
  const payloadHash = await sha256Hex(canonicalObservation(o));
  const observationId = (
    await sha256Hex(
      `${sourceId}|${OBJECT_TYPE}|${o.object_id}|${o.price_type}|${o.metric_code}|${o.stat_date}|${payloadHash}`,
    )
  ).slice(0, 32);
  return { observationId, payloadHash };
}

/**
 * 落库观测并重算受影响组的快照（幂等）。
 * 返回实际写入/更新行数与确定性 observation_id 列表。
 * @param batchId TASK-06D：观测归属批次（internal 受理传入；admin 手工补录为 null）。
 *   canonicalObservation 不含 batch_id——observation_id 确定性口径不变，
 *   重跑同观测仅更新 batch_id/collected_at，不产生重复行。
 */
export async function writeObservations(
  env: Env,
  sourceId: string,
  observations: ObservationInput[],
  batchId: string | null = null,
): Promise<WriteResult> {
  if (observations.length === 0) {
    return {
      observations_written: 0,
      snapshots_upserted: 0,
      observation_ids: [],
    };
  }

  // 1) 观测 upsert（确定性 ID；同观测重复提交 → DO UPDATE 幂等）
  const ids: string[] = [];
  const obsStmts = [];
  for (const o of observations) {
    const { observationId, payloadHash } = await observationIds(sourceId, o);
    ids.push(observationId);
    obsStmts.push(
      env.DB_PUBLIC.prepare(
        `INSERT INTO price_observations
           (observation_id, source_id, object_type, object_id, property_type,
            price_type, metric_code, price_total_fen, unit_price_yuan_sqm,
            area_sqm, sample_count, stat_date, quality_status, payload_hash,
            connector_version, index_value, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (observation_id) DO UPDATE SET
           price_total_fen = excluded.price_total_fen,
           unit_price_yuan_sqm = excluded.unit_price_yuan_sqm,
           area_sqm = excluded.area_sqm,
           sample_count = excluded.sample_count,
           quality_status = excluded.quality_status,
           payload_hash = excluded.payload_hash,
           connector_version = excluded.connector_version,
           index_value = excluded.index_value,
           batch_id = excluded.batch_id,
           collected_at = datetime('now')`,
      ).bind(
        observationId,
        sourceId,
        OBJECT_TYPE,
        o.object_id,
        o.property_type ?? null,
        o.price_type,
        o.metric_code,
        o.price_total_fen ?? null,
        o.unit_price_yuan_sqm ?? null,
        o.area_sqm ?? null,
        o.sample_count ?? 1,
        o.stat_date,
        o.quality_status ?? "valid",
        payloadHash,
        o.connector_version ?? null,
        o.index_value ?? null,
        batchId,
      ),
    );
  }
  const obsResults = await env.DB_PUBLIC.batch<{
    meta: { changes: number };
  }>(obsStmts);
  const observationsWritten = obsResults.reduce(
    (n, r) => n + r.meta.changes,
    0,
  );

  // 2) 受影响组全量重算（同 stat_date 内该组所有 valid 单价观测参与聚合）
  const groups = new Map<string, ObservationInput>();
  for (const o of observations) {
    groups.set(
      `${o.object_id}|${o.price_type}|${o.metric_code}|${o.stat_date}`,
      o,
    );
  }

  let snapshotsUpserted = 0;
  for (const o of groups.values()) {
    // official_index 无映射且无单价样本（SQL 过滤 unit_price IS NOT NULL）→ 跳过不写快照
    const snapshotMetric =
      OBS_TO_SNAPSHOT_METRIC[o.metric_code] ?? o.metric_code;
    const rows = await env.DB_PUBLIC.prepare(
      `SELECT source_id, unit_price_yuan_sqm FROM price_observations
       WHERE object_type = ? AND object_id = ? AND price_type = ?
         AND metric_code = ? AND stat_date = ?
         AND quality_status = 'valid' AND unit_price_yuan_sqm IS NOT NULL`,
    )
      .bind(OBJECT_TYPE, o.object_id, o.price_type, o.metric_code, o.stat_date)
      .all<{ source_id: string; unit_price_yuan_sqm: number }>();
    // 无可聚合样本：不写快照（不造数）
    if (rows.results.length === 0) continue;

    const stats = computeStats(rows.results.map((r) => r.unit_price_yuan_sqm));
    // TASK-09 R3：双源中位数交叉核验——有效源≥2 且相对偏差 > 阈值 → outlier
    // （median/mean/p25/p75 照常全量写入留痕，不隐藏；outlier 与 low_sample 互斥）
    const divergence = crossSourceDivergence(rows.results);
    const quality =
      divergence != null && divergence > CROSS_SOURCE_MAX_DIVERGENCE
        ? "outlier"
        : stats.sample_count >= MIN_VALID_SAMPLES
          ? "valid"
          : "low_sample";
    const snapshotKey = `${OBJECT_TYPE}|${o.object_id}|${o.price_type}|${snapshotMetric}|${o.stat_date}`;
    const snapshotId = (await sha256Hex(snapshotKey)).slice(0, 32);
    await env.DB_PUBLIC.prepare(
      `INSERT INTO price_snapshots
         (snapshot_id, object_type, object_id, price_type, metric_code,
          median, mean, p25, p75, sample_count, stat_date, source_id,
          quality_status, method_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (object_type, object_id, price_type, metric_code, stat_date)
       DO UPDATE SET
         median = excluded.median,
         mean = excluded.mean,
         p25 = excluded.p25,
         p75 = excluded.p75,
         sample_count = excluded.sample_count,
         collected_at = datetime('now'),
         source_id = excluded.source_id,
         quality_status = excluded.quality_status,
         method_version = excluded.method_version`,
    )
      .bind(
        snapshotId,
        OBJECT_TYPE,
        o.object_id,
        o.price_type,
        snapshotMetric,
        stats.median,
        stats.mean,
        stats.p25,
        stats.p75,
        stats.sample_count,
        o.stat_date,
        sourceId,
        quality,
        METHOD_VERSION,
      )
      .run();
    snapshotsUpserted += 1;
  }

  return {
    observations_written: observationsWritten,
    snapshots_upserted: snapshotsUpserted,
    observation_ids: ids,
  };
}
