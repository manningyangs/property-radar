import { describe, expect, it } from "vitest";
import {
  AUTOMATION_ALLOWED_STATUSES,
  CITY_STATUSES,
  PRICE_TYPES,
  SOURCE_STATUSES,
  priceStateFromChange,
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
