// TASK-08C：行情展示纯函数——样本分层、新鲜度、数值格式化、趋势序列。
// 纪律：所有数值一律来自后端快照字段；缺失显示 "—"，绝不补零或造数。
import type { PriceSnapshot } from "./api";

/** 样本分层阈值（与 SampleCountLabel 组件口径一致，PRD §2.5） */
export type SampleTier = "sufficient" | "limited" | "low" | "insufficient";

export function sampleTier(sampleCount: number | null): SampleTier {
  const n = sampleCount ?? 0;
  if (n >= 20) return "sufficient";
  if (n >= 10) return "limited";
  if (n >= 5) return "low";
  return "insufficient";
}

export const SAMPLE_TIER_TEXT: Record<SampleTier, string> = {
  sufficient: "样本相对充足",
  limited: "样本有限",
  low: "低样本，仅供观察",
  insufficient: "数据不足",
};

/** 低样本降级：low/insufficient 需降低视觉强调 */
export function isLowSample(sampleCount: number | null): boolean {
  const tier = sampleTier(sampleCount);
  return tier === "low" || tier === "insufficient";
}

/** SQLite datetime('now')（UTC 无时区后缀）按 UTC 语义解析；非法值 → null */
export function parseStatDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(value);
  const iso =
    !hasZone && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 数据新鲜度：距 stat_date 的天数 vs SLA。
 * ≤sla 天 fresh；≤2×sla delayed；更久或日期非法 stale（诚实降级，不掩盖）。
 */
export function freshnessStatus(
  statDate: string | null | undefined,
  nowMs: number,
  slaDays = 7,
): "fresh" | "delayed" | "stale" {
  const date = parseStatDate(statDate);
  if (!date) return "stale";
  const days = Math.floor((nowMs - date.getTime()) / 86_400_000);
  if (days <= slaDays) return "fresh";
  if (days <= slaDays * 2) return "delayed";
  return "stale";
}

/** 价格数值展示：千分位 + 单位；null/非法 → "—" */
export function formatPriceValue(
  value: number | null | undefined,
  unit?: string | null,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const text = value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return unit ? `${text} ${unit}` : text;
}

/** 快照列表是否存在可展示数据（空列表/全 null 中位数 → 诚实空态） */
export function hasDisplayableSnapshots(snapshots: PriceSnapshot[]): boolean {
  return snapshots.some((s) => s.median !== null || s.mean !== null);
}

/**
 * 趋势序列：按 metric_code+price_type 过滤并按 stat_date 升序；
 * 同日期重复快照保留 collected_at 最新的一条（缺省取列表序后者）。
 */
export function trendSeries(
  snapshots: PriceSnapshot[],
  metricCode: string,
  priceType?: string | null,
): PriceSnapshot[] {
  const filtered = snapshots.filter(
    (s) =>
      s.metric_code === metricCode &&
      (priceType === undefined ||
        priceType === null ||
        s.price_type === priceType),
  );
  const byDate = new Map<string, PriceSnapshot>();
  for (const s of filtered) {
    byDate.set(s.stat_date, s);
  }
  return [...byDate.values()].sort((a, b) =>
    a.stat_date.localeCompare(b.stat_date),
  );
}

/** 每个指标的最新快照（后端已按 stat_date DESC 排序，取每 metric_code 首条） */
export function latestPerMetric(snapshots: PriceSnapshot[]): PriceSnapshot[] {
  const seen = new Set<string>();
  const out: PriceSnapshot[] = [];
  for (const s of snapshots) {
    const key = `${s.metric_code}|${s.price_type ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** 指标代码中文口径（未知代码原样展示，不臆造） */
export const METRIC_LABELS: Record<string, string> = {
  median_price: "挂牌中位价",
  mean_price: "挂牌均价",
  p25_price: "挂牌 25 分位价",
  p75_price: "挂牌 75 分位价",
  transaction_median_price: "成交中位价",
  listing_count: "在售房源数",
};

export function metricLabel(code: string): string {
  return METRIC_LABELS[code] ?? code;
}

/** 价格类型中文口径 */
export const PRICE_TYPE_LABELS: Record<string, string> = {
  listing: "挂牌",
  transaction: "成交",
};

export function priceTypeLabel(code: string | null): string {
  if (!code) return "—";
  return PRICE_TYPE_LABELS[code] ?? code;
}
