import { describe, expect, it } from "vitest";
import {
  AUTOMATION_ALLOWED_STATUSES,
  CITY_STATUSES,
  PRICE_TYPES,
  RULE_TYPES,
  RULE_TEMPLATES,
  SOURCE_STATUSES,
  priceStateFromChange,
  validateRuleBinding,
} from "./index";

describe("核心枚举与 PRD 一致性", () => {
  it("价格类型包含 §4.1 全部口径且不重复", () => {
    expect(new Set(PRICE_TYPES).size).toBe(PRICE_TYPES.length);
    expect(PRICE_TYPES).toContain("filing_price");
    expect(PRICE_TYPES).toContain("manual_verified");
  });

  it("城市状态与数据源状态机齐全", () => {
    expect([...CITY_STATUSES]).toEqual([
      "active",
      "limited",
      "requestable",
      "suspended",
    ]);
    expect(
      AUTOMATION_ALLOWED_STATUSES.every((s) => SOURCE_STATUSES.includes(s)),
    ).toBe(true);
  });
});

describe("priceStateFromChange 样本量规则", () => {
  const base = { sufficient: 20, limited: 10, sample_count: 0 };

  it("样本 <5 不展示价格（返回 null）", () => {
    expect(priceStateFromChange(-5, { ...base, sample_count: 4 })).toBeNull();
  });

  it("低样本 5-9 与有限样本 ≥10 可展示趋势", () => {
    expect(priceStateFromChange(3, { ...base, sample_count: 6 })).toBe(
      "rising",
    );
    expect(priceStateFromChange(-3, { ...base, sample_count: 12 })).toBe(
      "falling",
    );
  });

  it("阈值 ±1.5% 内视为 stable", () => {
    expect(priceStateFromChange(0.4, { ...base, sample_count: 30 })).toBe(
      "stable",
    );
    expect(priceStateFromChange(-1.5, { ...base, sample_count: 30 })).toBe(
      "stable",
    );
    expect(priceStateFromChange(2, { ...base, sample_count: 30 })).toBe(
      "rising",
    );
  });
});

// ============================ TASK-03B：规则绑定矩阵 ============================

describe("RULE_TEMPLATES 结构", () => {
  it("覆盖 PRD §4.6 全部 5 种规则类型，且都不允许 region 对象", () => {
    expect(Object.keys(RULE_TEMPLATES).sort()).toEqual([...RULE_TYPES].sort());
    for (const t of Object.values(RULE_TEMPLATES)) {
      expect(t.object_types).not.toContain("region");
      expect(t.metrics.length).toBeGreaterThan(0);
    }
  });

  it("每个模板的指标三元组内 price_type/unit 自洽", () => {
    for (const t of Object.values(RULE_TEMPLATES)) {
      for (const m of t.metrics) {
        expect(m.price_type).toBe("listing_ask");
        expect(["元/㎡", "元"]).toContain(m.unit);
      }
    }
  });
});

describe("validateRuleBinding 绑定校验", () => {
  it("每种规则类型按主绑定均通过", () => {
    const cases: Array<[string, "community" | "listing"]> = [
      ["community_unit_price_lte", "community"],
      ["listing_total_price_lte", "listing"],
      ["listing_unit_price_lte", "listing"],
      ["below_comparable_median_pct", "listing"],
    ];
    for (const [ruleType, objectType] of cases) {
      const tpl = RULE_TEMPLATES[ruleType as keyof typeof RULE_TEMPLATES];
      const m = tpl.metrics[0]!;
      const input = {
        rule_type: ruleType,
        metric_code: m.metric_code,
        price_type: m.price_type,
        unit: m.unit,
        target_value: tpl.target === "required" ? 20000 : undefined,
        threshold_pct: tpl.threshold === "required" ? 5 : undefined,
        window_days: tpl.window === "required" ? 30 : undefined,
      };
      expect(validateRuleBinding(input, objectType), ruleType).toEqual([]);
    }
  });

  it("price_drop_pct 在 community 上用中位单价指标通过", () => {
    expect(
      validateRuleBinding(
        {
          rule_type: "price_drop_pct",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          unit: "元/㎡",
          threshold_pct: 5,
          window_days: 30,
        },
        "community",
      ),
    ).toEqual([]);
  });

  it("验收 1a：listing 对象不能挂小区单价规则（小区中位价 vs 房源）", () => {
    const errors = validateRuleBinding(
      {
        rule_type: "community_unit_price_lte",
        metric_code: "community_ask_median_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
        target_value: 20000,
      },
      "listing",
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("仅适用于 community 对象");
  });

  it("验收 1b：listing 对象用小区中位价指标 → 专属文案", () => {
    const errors = validateRuleBinding(
      {
        rule_type: "price_drop_pct",
        metric_code: "community_ask_median_unit",
        price_type: "listing_ask",
        unit: "元/㎡",
        threshold_pct: 5,
        window_days: 30,
      },
      "listing",
    );
    expect(errors[0]).toContain("不能把小区挂牌中位价与具体房源比较");
  });

  it("验收 1c：community 对象不能挂房源总价规则", () => {
    const errors = validateRuleBinding(
      {
        rule_type: "listing_total_price_lte",
        metric_code: "listing_ask_total",
        price_type: "listing_ask",
        unit: "元",
        target_value: 3000000,
      },
      "community",
    );
    expect(errors.length).toBeGreaterThan(0);
  });

  it("验收 2：官方指数不能作为元/㎡目标价", () => {
    const errors = validateRuleBinding(
      {
        rule_type: "community_unit_price_lte",
        metric_code: "official_price_index",
        price_type: "official_index",
        unit: "元/㎡",
        target_value: 100,
      },
      "community",
    );
    expect(errors[0]).toContain("官方指数不能作为元/㎡目标价");
  });

  it("单位必须与指标口径一致（中位单价 + 元 总价单位 → 拒绝）", () => {
    const errors = validateRuleBinding(
      {
        rule_type: "community_unit_price_lte",
        metric_code: "community_ask_median_unit",
        price_type: "listing_ask",
        unit: "元",
        target_value: 20000,
      },
      "community",
    );
    expect(errors.some((e) => e.includes("单位必须是「元/㎡」"))).toBe(true);
  });

  it("price_type 缺失或错配均拒绝", () => {
    expect(
      validateRuleBinding(
        {
          rule_type: "community_unit_price_lte",
          metric_code: "community_ask_median_unit",
          unit: "元/㎡",
          target_value: 20000,
        },
        "community",
      ).some((e) => e.includes("必须绑定 price_type")),
    ).toBe(true);
    expect(
      validateRuleBinding(
        {
          rule_type: "community_unit_price_lte",
          metric_code: "community_ask_median_unit",
          price_type: "closed_transaction",
          unit: "元/㎡",
          target_value: 20000,
        },
        "community",
      ).some((e) => e.includes("price_type 必须是 listing_ask")),
    ).toBe(true);
  });

  it("字段策略：lte 缺目标价拒绝、跌幅带 target_value 拒绝、跌幅缺窗口拒绝", () => {
    expect(
      validateRuleBinding(
        {
          rule_type: "community_unit_price_lte",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          unit: "元/㎡",
        },
        "community",
      ).some((e) => e.includes("缺少必需字段 target_value")),
    ).toBe(true);
    expect(
      validateRuleBinding(
        {
          rule_type: "price_drop_pct",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          unit: "元/㎡",
          threshold_pct: 5,
          window_days: 30,
          target_value: 20000,
        },
        "community",
      ).some((e) => e.includes("不支持字段 target_value")),
    ).toBe(true);
    expect(
      validateRuleBinding(
        {
          rule_type: "price_drop_pct",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          unit: "元/㎡",
          threshold_pct: 5,
        },
        "community",
      ).some((e) => e.includes("缺少必需字段 window_days")),
    ).toBe(true);
  });

  it("目标价必须大于 0", () => {
    expect(
      validateRuleBinding(
        {
          rule_type: "community_unit_price_lte",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          unit: "元/㎡",
          target_value: 0,
        },
        "community",
      ).some((e) => e.includes("目标价必须大于 0")),
    ).toBe(true);
  });

  it("未知 rule_type / 区域对象被拒", () => {
    expect(
      validateRuleBinding({ rule_type: "whatever" }, "community")[0],
    ).toContain("rule_type 必须是");
    expect(
      validateRuleBinding(
        {
          rule_type: "community_unit_price_lte",
          metric_code: "community_ask_median_unit",
          price_type: "listing_ask",
          unit: "元/㎡",
          target_value: 1,
        },
        "region",
      )[0],
    ).toContain("区域对象暂不支持");
  });
});
