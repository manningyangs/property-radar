// 核心共享常量——与 PRD V1.2 §4/§5 状态机保持一致
// 价格类型（§4.1）
export const PRICE_TYPES = [
  "listing", // 挂牌价
  "transaction", // 成交价
  "official_index", // 官方指数
  "platform_average", // 平台均价
  "estimated", // 估算价
  "filing_price", // 备案价（一手网签备案，不得标成成交价）
  "manual_verified", // 用户手工核验（含原站跳转时间戳）
] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

// 城市状态（§4.4；城市目录状态与数据覆盖状态分离，不设全站唯一城市）
export const CITY_STATUSES = [
  "active",
  "limited",
  "requestable",
  "suspended",
] as const;
export type CityStatus = (typeof CITY_STATUSES)[number];

// 城市目录状态（catalog_status，与数据覆盖无关）
export const CATALOG_STATUSES = ["active", "pending", "disabled"] as const;
export type CatalogStatus = (typeof CATALOG_STATUSES)[number];

// 数据源状态（§5.2）
export const SOURCE_STATUSES = [
  "discovered",
  "pending_review",
  "manual_only",
  "approved_open",
  "approved_licensed",
  "suspended",
  "blocked",
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const AUTOMATION_ALLOWED_STATUSES: readonly SourceStatus[] = [
  "approved_open",
  "approved_licensed",
];

// 监控规则状态（§3.1）
export const RULE_STATUSES = ["active", "paused", "expired"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

// 价格状态：source_city_coverage.status + sample_count 判定（§4.4）
export const PRICE_STATES = ["rising", "stable", "falling"] as const;
export type PriceState = (typeof PRICE_STATES)[number];

export interface SampleSummary {
  sample_count: number;
  sufficient: number;
  limited: number;
}

/**
 * 样本量门槛（§4.4）：≥20 充足、10–19 有限、5–9 低样本、<5 不展示价格（禁止编造价格）。
 */
export const SAMPLE_THRESHOLDS = {
  sufficient: 20,
  limited: 10,
  low: 5,
} as const;

/**
 * 根据价格变化百分比与样本量判定价格状态。
 * - 样本 <5：返回 null（页面不得展示价格）
 * - 变化 > +1.5%：rising；< -1.5%：falling；其余：stable
 */
export function priceStateFromChange(
  changePercent: number,
  samples: SampleSummary,
): PriceState | null {
  if (samples.sample_count < SAMPLE_THRESHOLDS.low) return null;
  if (changePercent > 1.5) return "rising";
  if (changePercent < -1.5) return "falling";
  return "stable";
}
