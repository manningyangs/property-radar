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

// ============================ TASK-03B：规则模板与绑定校验 ============================
// PRD §4.6 目标价规则：rule_type × object_type × (metric_code, price_type, unit) 绑定矩阵。
// 前后端共用（apps/api 校验入参、apps/web 渲染表单），验收要求：
//   - 不允许拿小区挂牌中位价与具体房源总价比较；
//   - 不允许将官方指数作为元/㎡目标价。

export const RULE_TYPES = [
  "community_unit_price_lte",
  "listing_total_price_lte",
  "listing_unit_price_lte",
  "price_drop_pct",
  "below_comparable_median_pct",
] as const;
export type RuleType = (typeof RULE_TYPES)[number];

/** 监控对象类型（与 watch_items.object_type 一致） */
export type RuleObjectType = "region" | "community" | "listing";

/** 字段输入策略：required=必填、optional=可选、forbidden=出现即报错 */
export type FieldPolicy = "required" | "optional" | "forbidden";

/** 规则绑定的指标三元组：指标编码 + 价格口径 + 单位（单位为 null 表示该口径无单位） */
export interface RuleMetricBinding {
  metric_code: string;
  price_type: string;
  unit: string | null;
}

export interface RuleTemplate {
  rule_type: RuleType;
  label: string;
  /** 允许挂载该规则的监控对象类型（region 暂无区域级指标，任何模板都不含 region） */
  object_types: RuleObjectType[];
  /** 允许的 metric_code+price_type+unit 绑定；第一条为主绑定（表单默认） */
  metrics: RuleMetricBinding[];
  target: FieldPolicy;
  threshold: FieldPolicy;
  window: FieldPolicy;
}

export const RULE_TEMPLATES: Record<RuleType, RuleTemplate> = {
  community_unit_price_lte: {
    rule_type: "community_unit_price_lte",
    label: "小区挂牌单价 ≤ 目标价",
    object_types: ["community"],
    metrics: [
      {
        metric_code: "community_ask_median_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
      },
    ],
    target: "required",
    threshold: "forbidden",
    window: "forbidden",
  },
  listing_total_price_lte: {
    rule_type: "listing_total_price_lte",
    label: "房源挂牌总价 ≤ 目标总价",
    object_types: ["listing"],
    metrics: [
      {
        metric_code: "listing_ask_total",
        price_type: "listing_ask",
        unit: "元",
      },
    ],
    target: "required",
    threshold: "forbidden",
    window: "forbidden",
  },
  listing_unit_price_lte: {
    rule_type: "listing_unit_price_lte",
    label: "房源挂牌单价 ≤ 目标单价",
    object_types: ["listing"],
    metrics: [
      {
        metric_code: "listing_ask_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
      },
    ],
    target: "required",
    threshold: "forbidden",
    window: "forbidden",
  },
  price_drop_pct: {
    rule_type: "price_drop_pct",
    label: "窗口期跌幅 ≥ 阈值",
    object_types: ["community", "listing"],
    metrics: [
      {
        metric_code: "community_ask_median_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
      },
      {
        metric_code: "listing_ask_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
      },
      {
        metric_code: "listing_ask_total",
        price_type: "listing_ask",
        unit: "元",
      },
    ],
    target: "forbidden",
    threshold: "required",
    window: "required",
  },
  below_comparable_median_pct: {
    rule_type: "below_comparable_median_pct",
    label: "房源单价低于可比中位数 ≥ 阈值",
    object_types: ["listing"],
    metrics: [
      {
        metric_code: "listing_ask_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
      },
    ],
    target: "forbidden",
    threshold: "required",
    window: "optional",
  },
};

/** 校验入参（POST/PATCH 的合并态）；object_type 取父 watch_item */
export interface RuleBindingInput {
  rule_type?: unknown;
  metric_code?: unknown;
  price_type?: unknown;
  unit?: unknown;
  target_value?: unknown;
  threshold_pct?: unknown;
  window_days?: unknown;
}

const METRIC_LABELS: Record<string, string> = {
  official_price_index: "官方指数",
  community_ask_median_unit: "小区挂牌中位单价",
  listing_ask_total: "房源挂牌总价",
  listing_ask_unit: "房源挂牌单价",
};

function label(metric: string): string {
  return METRIC_LABELS[metric] ?? metric;
}

/** 指标层级：community_* 为小区级、listing_* 为房源级；其余（官方指数/成交等）返回 null */
function metricScope(code: string): "community" | "listing" | null {
  if (code.startsWith("community_")) return "community";
  if (code.startsWith("listing_")) return "listing";
  return null;
}

/**
 * 规则绑定交叉校验（PRD TASK-03B 验收的唯一裁决点）。
 * 返回中文错误信息数组；空数组 = 通过。只做语义层校验，长度/类型等
 * 形状校验由 API 层 JSON Schema 负责。
 */
export function validateRuleBinding(
  input: RuleBindingInput,
  objectType: RuleObjectType,
): string[] {
  const errors: string[] = [];
  const ruleType = input.rule_type;

  if (typeof ruleType !== "string" || !(ruleType in RULE_TEMPLATES)) {
    errors.push(`rule_type 必须是 ${RULE_TYPES.join("、")} 之一`);
    return errors;
  }
  const template = RULE_TEMPLATES[ruleType as RuleType];

  // 1) 对象类型匹配
  if (!template.object_types.includes(objectType)) {
    if (objectType === "region") {
      errors.push("区域对象暂不支持配置规则（区域指标待接入）");
    } else {
      errors.push(
        `规则类型「${template.label}」仅适用于 ${template.object_types.join("、")} 对象，不能挂在 ${objectType} 对象上`,
      );
    }
    return errors;
  }

  const metricCode = input.metric_code;
  const priceType = input.price_type;
  const unit = input.unit;

  // 2) 指标层级必须与对象层级一致：小区指标不能挂房源对象、反之亦然
  // （price_drop_pct 同时允许两类对象与指标，仅靠模板集合拦不住跨层级组合）
  const scope = typeof metricCode === "string" ? metricScope(metricCode) : null;
  if (scope !== null && scope !== objectType) {
    if (scope === "community" && objectType === "listing") {
      errors.push(
        "不能把小区挂牌中位价与具体房源比较：listing 对象必须使用房源级指标（listing_ask_unit / listing_ask_total）",
      );
    } else if (scope === "listing" && objectType === "community") {
      errors.push(
        "不能把房源级指标挂在小区对象上：community 对象请使用 community_ask_median_unit",
      );
    } else {
      errors.push(
        `指标 ${label(String(metricCode))} 的层级与 ${objectType} 对象不匹配`,
      );
    }
    return errors;
  }

  // 3) 指标绑定：metric_code 必须命中该模板允许集合
  const allowedMetrics = template.metrics;
  const metricHit = allowedMetrics.find((m) => m.metric_code === metricCode);
  if (!metricHit) {
    // 验收专属文案：官方指数当目标口径
    if (metricCode === "official_price_index") {
      errors.push(
        unit === "元/㎡"
          ? "官方指数不能作为元/㎡目标价：official_price_index 没有面积单价口径"
          : "官方指数不支持配置为该规则的比较指标（price_type 应为 official_index 且不参与目标价比较）",
      );
      return errors;
    }
    errors.push(
      `指标 ${label(String(metricCode))}（${String(metricCode)}）不适用于该规则类型，允许的指标：${allowedMetrics.map((m) => m.metric_code).join("、")}`,
    );
    return errors;
  }

  // 4) price_type 必须绑定且与指标绑定一致（PRD 03B：规则必须绑定 metric_code 和 price_type）
  if (priceType === undefined || priceType === null) {
    errors.push(
      `规则必须绑定 price_type（指标 ${metricCode} 要求 ${metricHit.price_type}）`,
    );
  } else if (priceType !== metricHit.price_type) {
    errors.push(
      `指标 ${metricCode} 的 price_type 必须是 ${metricHit.price_type}（收到 ${String(priceType)}）`,
    );
  }

  // 5) 单位与口径一致
  if (metricHit.unit === null) {
    if (unit !== undefined && unit !== null) {
      errors.push(`指标 ${metricCode} 不应携带单位（收到 ${String(unit)}）`);
    }
  } else if (unit !== metricHit.unit) {
    errors.push(
      `指标 ${metricCode} 的单位必须是「${metricHit.unit}」（收到 ${unit === null || unit === undefined ? "空" : String(unit)}）`,
    );
  }

  // 6) 字段策略
  const policies: Array<[string, FieldPolicy, unknown]> = [
    ["target_value", template.target, input.target_value],
    ["threshold_pct", template.threshold, input.threshold_pct],
    ["window_days", template.window, input.window_days],
  ];
  for (const [field, policy, value] of policies) {
    const present = value !== undefined && value !== null;
    if (policy === "required" && !present) {
      errors.push(`规则类型「${template.label}」缺少必需字段 ${field}`);
    }
    if (policy === "forbidden" && present) {
      errors.push(`规则类型「${template.label}」不支持字段 ${field}`);
    }
  }
  if (
    template.target === "required" &&
    typeof input.target_value === "number" &&
    !(input.target_value > 0)
  ) {
    errors.push("目标价必须大于 0");
  }

  return errors;
}
