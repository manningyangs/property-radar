// TASK-08C T1：行情展示纯函数测试（样本分层/新鲜度/格式化/趋势序列）。
import { describe, expect, it } from "vitest";
import type { PriceSnapshot } from "./api";
import {
  formatPriceValue,
  freshnessStatus,
  hasDisplayableSnapshots,
  isLowSample,
  latestPerMetric,
  metricLabel,
  parseStatDate,
  sampleTier,
  trendSeries,
} from "./market";

function snap(
  overrides: Partial<PriceSnapshot> & Pick<PriceSnapshot, "metric_code">,
): PriceSnapshot {
  return {
    snapshot_id:
      overrides.snapshot_id ?? `s_${Math.random().toString(36).slice(2)}`,
    price_type: "listing",
    median: 30000,
    mean: 31000,
    p25: 28000,
    p75: 34000,
    sample_count: 25,
    stat_date: "2026-11-15",
    quality_status: "valid",
    ...overrides,
  };
}

describe("sampleTier / isLowSample", () => {
  it("阈值边界与 SampleCountLabel 一致（20/10/5）", () => {
    expect(sampleTier(20)).toBe("sufficient");
    expect(sampleTier(19)).toBe("limited");
    expect(sampleTier(10)).toBe("limited");
    expect(sampleTier(9)).toBe("low");
    expect(sampleTier(5)).toBe("low");
    expect(sampleTier(4)).toBe("insufficient");
    expect(sampleTier(null)).toBe("insufficient");
  });

  it("low/insufficient 触发降级", () => {
    expect(isLowSample(9)).toBe(true);
    expect(isLowSample(10)).toBe(false);
    expect(isLowSample(null)).toBe(true);
  });
});

describe("parseStatDate", () => {
  it("无时区后缀按 UTC 解析", () => {
    const d = parseStatDate("2026-11-15 08:00:00");
    expect(d?.toISOString()).toBe("2026-11-15T08:00:00.000Z");
  });

  it("非法/空 → null", () => {
    expect(parseStatDate("not-a-date")).toBeNull();
    expect(parseStatDate(null)).toBeNull();
    expect(parseStatDate(undefined)).toBeNull();
  });
});

describe("freshnessStatus", () => {
  const now = Date.parse("2026-11-17T00:00:00Z");

  it("SLA 内 fresh；超 SLA 未过 2 倍 delayed；更久 stale", () => {
    expect(freshnessStatus("2026-11-15", now, 7)).toBe("fresh");
    expect(freshnessStatus("2026-11-10", now, 7)).toBe("fresh"); // 恰好第 7 天
  });

  it("边界：第 8 天 delayed，第 15 天 stale，日期非法 stale", () => {
    expect(freshnessStatus("2026-11-09", now, 7)).toBe("delayed");
    expect(freshnessStatus("2026-11-02", now, 7)).toBe("stale");
    expect(freshnessStatus(null, now)).toBe("stale");
    expect(freshnessStatus("garbage", now)).toBe("stale");
  });
});

describe("formatPriceValue", () => {
  it("千分位 + 单位；缺失一律 —（不补零）", () => {
    expect(formatPriceValue(30123.456, "元/㎡")).toBe("30,123.46 元/㎡");
    expect(formatPriceValue(null)).toBe("—");
    expect(formatPriceValue(Number.NaN)).toBe("—");
    expect(formatPriceValue(0)).toBe("0");
  });
});

describe("hasDisplayableSnapshots", () => {
  it("空列表/全 null 指标 → false", () => {
    expect(hasDisplayableSnapshots([])).toBe(false);
    expect(
      hasDisplayableSnapshots([
        snap({ metric_code: "median_price", median: null, mean: null }),
      ]),
    ).toBe(false);
    expect(
      hasDisplayableSnapshots([snap({ metric_code: "median_price" })]),
    ).toBe(true);
  });
});

describe("trendSeries", () => {
  it("过滤口径并按日期升序", () => {
    const series = trendSeries(
      [
        snap({ metric_code: "median_price", stat_date: "2026-11-15" }),
        snap({ metric_code: "mean_price", stat_date: "2026-11-14" }),
        snap({ metric_code: "median_price", stat_date: "2026-11-01" }),
      ],
      "median_price",
      "listing",
    );
    expect(series.map((s) => s.stat_date)).toEqual([
      "2026-11-01",
      "2026-11-15",
    ]);
  });

  it("同日重复快照只保留一条", () => {
    const series = trendSeries(
      [
        snap({
          metric_code: "median_price",
          stat_date: "2026-11-15",
          median: 1,
        }),
        snap({
          metric_code: "median_price",
          stat_date: "2026-11-15",
          median: 2,
        }),
      ],
      "median_price",
    );
    expect(series).toHaveLength(1);
    expect(series[0]?.median).toBe(2);
  });
});

describe("latestPerMetric / metricLabel", () => {
  it("每 metric+price_type 取首条（后端倒序=最新）", () => {
    const latest = latestPerMetric([
      snap({ metric_code: "median_price", stat_date: "2026-11-15" }),
      snap({ metric_code: "median_price", stat_date: "2026-11-01" }),
      snap({ metric_code: "mean_price", stat_date: "2026-11-10" }),
    ]);
    expect(latest).toHaveLength(2);
    expect(latest[0]?.stat_date).toBe("2026-11-15");
  });

  it("未知指标原样透传，不臆造文案", () => {
    expect(metricLabel("median_price")).toBe("挂牌中位价");
    expect(metricLabel("weird_code")).toBe("weird_code");
  });
});
