// TASK-04E：数据清洗规则模块——服务端唯一实现点（spec R1；PRD 任务行 1312–1318 / §11.1 步骤 3–4）
// internal 批次与 admin 手工补录两条路径共用，先于任何 DB 写执行：400 时零行落库
// （拍板 1：异常仅计数留痕不落库——响应 details 字段级列表即留痕）。
// 六类规则（fixture 见 cleaning.test.ts，spec §2 R4 表）：
//   1) 语义（承接 04D assertObservationSemantics 并扩展）：总价与单价至少一非空、area_sqm > 0、
//      指数互斥——official_index 必带 index_value（0 < v ≤ 1000）且禁金额/面积字段，
//      价格类观测禁带 index_value（与 Python schema.py normalize 同口径）；
//   2) 极端价格：unit_price_yuan_sqm > 10 万/㎡ 或 price_total_fen > 1000 万元 → 400
//      （阈值与 Python _MAX_UNIT_YUAN/_MAX_TOTAL_FEN 同源，本模块为服务端唯一真源）；
//   3) 未来日期：stat_date 晚于 Asia/Shanghai 当日 → 400（造假防护，取沪市当日避免
//      UTC 早八点误拒，拍板 3；早于最新快照的旧日期入历史不拒绝）；
//   4) 过期物化（拍板 2）：stat_date < 当日 − STALE_AFTER_DAYS[price_type] →
//      quality_status 覆盖为 'stale' 后照常入库；聚合只统计 valid → 过期组无有效样本，
//      不写快照（snapshots_upserted=0，不造数）；
//   5) 批内去重：按确定性 observation_id 去重，响应附 duplicates_dropped；
//      跨批同 payload 重提走 04D ON CONFLICT DO UPDATE 幂等；
//   6) 口径常量唯一真源（spec R2）：METHOD_VERSION / MIN_VALID_SAMPLES / STALE_AFTER_DAYS /
//      极端阈值 / OBS_TO_SNAPSHOT_METRIC 集中在本模块导出，口径变更必须同步升 METHOD_VERSION。
import { errors } from "./errors";
import { observationIds, type ObservationInput } from "./observations";

// ---------------- 口径常量（唯一真源，spec R1-6 / R2） ----------------

/**
 * 快照聚合方法版本（spec R2 口径要素——任何口径变更必须同步升版本并留痕 method_version）：
 *   04e-aggregate-v2 —— 04E：落库前清洗六规则、official_index 指数双口径
 *     （index_value 条件入 canonical 与落库列）、stale 过期物化随写入判定；
 *   04d-aggregate-v1 —— 04D 初版：median/mean/p25/p75 线性插值。
 * percentile 口径（R2 要素说明）：分位数用 numpy.percentile 默认 linear 插值
 * （idx=(n-1)*p），实现于 observations.ts computeStats（04E 未改算法）。
 */
export const METHOD_VERSION = "04e-aggregate-v2";

/**
 * 观测指标 → 快照指标（spec R2：固定代码常量，禁止散落字符串）：
 * 逐套挂牌单价样本 → 小区挂牌单价中位数（PRD §4.2 小区指标）。
 * official_index 不新增映射（spec R3 聚合边界）：指数观测不携带单价，快照聚合 SQL 仅取
 * quality_status='valid' AND unit_price_yuan_sqm IS NOT NULL，指数行天然不参与——无样本即不写快照。
 */
export const OBS_TO_SNAPSHOT_METRIC: Record<string, string> = {
  listing_ask_unit: "community_ask_median_unit",
};

/** spec R1-6：小样本降级阈值——快照 sample_count ≥ 5 → valid，否则 low_sample（04D 口径不变） */
export const MIN_VALID_SAMPLES = 5;

/** spec R1-2：单价极端上限（10 万元/㎡；> 即拒绝，与 Python schema.py _MAX_UNIT_YUAN 同源） */
export const MAX_UNIT_PRICE_YUAN_SQM = 100_000;

/** spec R1-2：总价极端上限（1000 万元 = 10 亿分；> 即拒绝，与 Python _MAX_TOTAL_FEN 同源） */
export const MAX_PRICE_TOTAL_FEN = 1_000_000_000;

/** spec R1-1：指数值合理上限（现实指数 50~150 量级；0 < v ≤ 1000 服务端口径） */
export const MAX_INDEX_VALUE = 1000;

/** spec R1-4：过期物化阈值（拍板 2：按 price_type 区分；未列出的口径用默认值） */
export const STALE_AFTER_DAYS: Readonly<Record<string, number>> = {
  official_index: 92, // 月度来源 stat_date 天然滞后一个季度以内
};

/** 过期物化默认阈值（天）：价格类观测 30 天 */
export const DEFAULT_STALE_AFTER_DAYS = 30;

/** 某 price_type 的过期阈值（天） */
export function staleAfterDays(priceType: string): number {
  return STALE_AFTER_DAYS[priceType] ?? DEFAULT_STALE_AFTER_DAYS;
}

// ---------------- 清洗实现 ----------------

/** Asia/Shanghai 当日（YYYY-MM-DD，UTC+8 无夏令时，直接平移取日期） */
function shanghaiDate(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

export interface CleanResult {
  /** 通过全部清洗规则、可落库的观测（过期项已物化 quality_status='stale'） */
  cleaned: ObservationInput[];
  /** 批内按确定性 observation_id 去重剔除的条数（跨批幂等由 04D upsert 负责） */
  duplicates_dropped: number;
  /** 落库行中 quality_status='stale' 的条数（含提交方显式标记的过期行） */
  stale_count: number;
}

/**
 * 清洗一批观测（纯函数：不触库、时钟由 now 注入供测试；仅抛 400 validation 或返回结果）。
 * @param observations 原始观测（schema 校验通过后的输入，不被修改）
 * @param now 当前时刻——未来日期与过期物化均以 Asia/Shanghai 当日为基准
 * @param sourceId 批内去重需按确定性 observation_id（含 source_id 分量）计算
 * @param prefix details 字段路径前缀：批内数组 "/observations"，admin 单条 ""
 * @throws AppError 400 validation_failed——details 逐条列出字段路径（拍板 1 留痕）
 */
export async function cleanObservations(
  observations: ObservationInput[],
  now: Date,
  sourceId: string,
  prefix: string,
): Promise<CleanResult> {
  const today = shanghaiDate(now.getTime());
  const details: Array<{ field: string; message: string }> = [];

  // 1)–3) 语义 / 指数互斥 / 极端价格 / 未来日期：任一命中即整体 400（零行落库）
  observations.forEach((o, i) => {
    const at = prefix === "" ? "" : `${prefix}/${i}`;
    const field = (key: string) => (at === "" ? `/${key}` : `${at}/${key}`);
    const item = at === "" ? "/" : at;

    if (o.price_type === "official_index") {
      if (o.index_value == null) {
        details.push({ field: item, message: "指数观测必须携带 index_value" });
      } else if (!(o.index_value > 0 && o.index_value <= MAX_INDEX_VALUE)) {
        details.push({
          field: field("index_value"),
          message: `指数值须满足 0 < v ≤ ${MAX_INDEX_VALUE}`,
        });
      }
      if (
        o.price_total_fen != null ||
        o.unit_price_yuan_sqm != null ||
        o.area_sqm != null
      ) {
        details.push({
          field: item,
          message: "指数观测不得携带金额或面积字段",
        });
      }
    } else {
      if (o.price_total_fen == null && o.unit_price_yuan_sqm == null) {
        details.push({ field: item, message: "总价与单价至少一项非空" });
      }
      if (o.area_sqm != null && o.area_sqm <= 0) {
        details.push({ field: field("area_sqm"), message: "面积必须大于 0" });
      }
      if (o.index_value != null) {
        details.push({
          field: field("index_value"),
          message: "价格类观测不得携带 index_value",
        });
      }
      if (
        o.unit_price_yuan_sqm != null &&
        o.unit_price_yuan_sqm > MAX_UNIT_PRICE_YUAN_SQM
      ) {
        details.push({
          field: field("unit_price_yuan_sqm"),
          message: `单价超出极端上限 ${MAX_UNIT_PRICE_YUAN_SQM} 元/㎡`,
        });
      }
      if (
        o.price_total_fen != null &&
        o.price_total_fen > MAX_PRICE_TOTAL_FEN
      ) {
        details.push({
          field: field("price_total_fen"),
          message: `总价超出极端上限 ${MAX_PRICE_TOTAL_FEN} 分（1000 万元）`,
        });
      }
    }

    if (o.stat_date > today) {
      details.push({
        field: field("stat_date"),
        message: `统计日期不得晚于当日（Asia/Shanghai ${today}）`,
      });
    }
  });
  if (details.length > 0) throw errors.validation(details);

  // 4) 过期物化（写入时判定即结论；同组 stat_date 同键，整组同为过期或新鲜）
  const withStale: ObservationInput[] = observations.map((o) => {
    const cutoff = shanghaiDate(
      now.getTime() - staleAfterDays(o.price_type) * 86_400_000,
    );
    return o.stat_date < cutoff ? { ...o, quality_status: "stale" } : o;
  });

  // 5) 批内按确定性 observation_id 去重（保留首个；哈希含 source_id，批内 source 恒定）
  const seen = new Set<string>();
  const deduped: ObservationInput[] = [];
  for (const o of withStale) {
    const { observationId } = await observationIds(sourceId, o);
    if (seen.has(observationId)) continue;
    seen.add(observationId);
    deduped.push(o);
  }

  return {
    cleaned: deduped,
    duplicates_dropped: observations.length - deduped.length,
    stale_count: deduped.filter((o) => o.quality_status === "stale").length,
  };
}
