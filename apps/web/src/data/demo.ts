/**
 * TASK-01B 演示数据（DEMO）
 *
 * 红线（任务书强制）：
 *  1. 仅当 `PUBLIC_DEMO_DATA === "1"` 时页面才允许导入/渲染本模块；
 *     默认构建（CI / pnpm build 无该变量）不得出现任何行情数字，
 *     页面必须降级为 EmptyState「暂未覆盖，可提交覆盖申请」。
 *  2. 全部对象使用虚构名称（演示市 / 晴川花园（演示）…），
 *     严禁为任何真实城市或真实小区编造价格。
 *  3. 真实城市目录（config/cities/city-catalog.json）只作为选择器元数据，
 *     全部 status=requestable，绝不携带价格。
 */

/** 涨跌方向：上涨 / 下降 / 持平（必须与文字+箭头同时出现，颜色不是唯一编码） */
export type Direction = "up" | "down" | "flat";

/** 数据覆盖状态 */
export type CoverageStatus = "ok" | "stale" | "low" | "none";

export interface DemoCity {
  name: string;
  code: string;
  status: "active" | "limited";
  note: string;
}

export interface DemoFreshness {
  lastSuccess: string;
  communities: number;
  delayedSources: number;
}

export interface DemoStale {
  source: string;
  lastValid: string;
  days: number;
}

export interface DemoRegion {
  id: string;
  name: string;
  city: string;
  /** 挂牌参考口径 */
  listMedian: number;
  listAvg: number;
  listChange: number;
  listSample: number;
  /** 实际成交口径（演示） */
  dealMedian: number;
  dealChange: number;
  dealSample: number;
  direction: Direction;
  quality: "A" | "B" | "C";
  /** 各统计周期的趋势序列（确定性生成，供内联 SVG 使用） */
  series: Record<string, number[]>;
  /** 实际成交口径的趋势序列（与挂牌口径分别呈现） */
  dealSeries: Record<string, number[]>;
  status: CoverageStatus;
}

export interface DemoCommunity {
  id: string;
  name: string;
  regionId: string;
  regionName: string;
  plate: string;
  /** 挂牌中位价；null = 样本不足不发布价格（必须显示“数据不足”而非编造） */
  median: number | null;
  avg: number | null;
  p25: number | null;
  p75: number | null;
  sample: number;
  change30: number;
  direction: Direction;
  status: CoverageStatus;
  source: string;
  collectedAt: string;
  statDate: string;
  quality: "A" | "B" | "C";
  series: Record<string, number[]>;
  /** 样本变化（近 30 日） */
  sampleDelta: { added: number; reduced: number; removed: number };
}

export interface DemoEvent {
  id: string;
  level: "high" | "mid" | "low";
  type: string;
  target: string;
  targetType: string;
  before: number;
  after: number;
  direction: Direction;
  deltaAmount: number;
  deltaPct: number;
  statDate: string;
  source: string;
  sample: number;
  quality: "A" | "B" | "C";
  read: boolean;
  explanation: string;
  evidence: string[];
}

export interface DemoWatchItem {
  id: string;
  name: string;
  type: "区域" | "板块" | "小区" | "房源";
  metric: string;
  current: number;
  target: number;
  unit: string;
  direction: Direction;
  statDate: string;
  collectedAt: string;
  sample: number;
  quality: "A" | "B" | "C";
  paused: boolean;
  triggered: boolean;
  lastEvent: string;
  /** 目标进度百分比（0–100，条形可视化） */
  progress: number;
}

export interface DemoRule {
  id: string;
  target: string;
  metric: string;
  condition: string;
  channels: string[];
  enabled: boolean;
  updatedAt: string;
}

/** 管理后台对象目录行（用 type 以便赋给 Record<string, string | number> 表格行） */
export type DemoAdminRow = {
  id: string;
  object: string;
  type: string;
  status: "正常" | "待审核" | "已停用";
  sample: number;
  updated: string;
  source: string;
  owner: string;
};

/** 确定性伪随机序列生成：同一输入永远得到同一条曲线（禁止运行时随机） */
function makeSeries(
  base: number,
  drift: number,
  wobble: number,
  n: number,
): number[] {
  let seed = Math.abs(Math.round(base)) + n * 7;
  const points: number[] = [];
  let value = base;
  for (let i = 0; i < n; i += 1) {
    seed = (seed * 9301 + 49297) % 233280;
    const noise = seed / 233280 - 0.5;
    value = value * (1 + drift + noise * wobble);
    points.push(Math.round(value));
  }
  return points;
}

/** 为各统计周期生成序列：7/30/90/180/360 日 */
function seriesAll(
  base: number,
  drift: number,
  wobble: number,
): Record<string, number[]> {
  return {
    "7": makeSeries(base, drift / 4, wobble, 7),
    "30": makeSeries(base, drift / 2, wobble, 10),
    "90": makeSeries(base, drift, wobble, 12),
    "180": makeSeries(base, drift * 1.6, wobble, 12),
    "360": makeSeries(base, drift * 2.4, wobble, 12),
  };
}

const regions: DemoRegion[] = [
  {
    id: "qingchuan",
    name: "晴川区",
    city: "演示市",
    listMedian: 21800,
    listAvg: 23100,
    listChange: 0.8,
    listSample: 126,
    dealMedian: 19600,
    dealChange: -1.1,
    dealSample: 41,
    direction: "up",
    quality: "B",
    series: seriesAll(21400, 0.006, 0.012),
    dealSeries: seriesAll(19800, -0.008, 0.01),
    status: "ok",
  },
  {
    id: "yunlan",
    name: "云澜区",
    city: "演示市",
    listMedian: 19400,
    listAvg: 20500,
    listChange: -1.2,
    listSample: 88,
    dealMedian: 17800,
    dealChange: -2.0,
    dealSample: 33,
    direction: "down",
    quality: "B",
    series: seriesAll(19900, -0.008, 0.01),
    dealSeries: seriesAll(18100, -0.012, 0.012),
    status: "ok",
  },
  {
    id: "xujiang",
    name: "溯江区",
    city: "演示市",
    listMedian: 17250,
    listAvg: 17900,
    listChange: 0,
    listSample: 41,
    dealMedian: 16100,
    dealChange: 0.2,
    dealSample: 18,
    direction: "flat",
    quality: "C",
    series: seriesAll(17250, 0, 0.006),
    dealSeries: seriesAll(16150, 0.001, 0.007),
    status: "stale",
  },
];

const communities: DemoCommunity[] = [
  {
    id: "qingchuan-huayuan",
    name: "晴川花园（演示）",
    regionId: "qingchuan",
    regionName: "晴川区",
    plate: "晴川板块",
    median: 21400,
    avg: 22100,
    p25: 19800,
    p75: 24300,
    sample: 12,
    change30: 2.1,
    direction: "up",
    status: "low",
    source: "演示数据源A",
    collectedAt: "2026-11-10 06:10",
    statDate: "2026-11-10",
    quality: "B",
    series: seriesAll(20960, 0.01, 0.014),
    sampleDelta: { added: 8, reduced: 3, removed: 5 },
  },
  {
    id: "yunlan-mingdi",
    name: "云澜名邸（演示）",
    regionId: "yunlan",
    regionName: "云澜区",
    plate: "云澜湾板块",
    median: 19760,
    avg: 20480,
    p25: 18300,
    p75: 22600,
    sample: 46,
    change30: -1.2,
    direction: "down",
    status: "stale",
    source: "演示数据源B",
    collectedAt: "2026-11-08 06:12",
    statDate: "2026-11-08",
    quality: "A",
    series: seriesAll(20000, -0.006, 0.008),
    sampleDelta: { added: 5, reduced: 9, removed: 4 },
  },
  {
    id: "xujiang-yayuan",
    name: "溯江雅苑（演示）",
    regionId: "xujiang",
    regionName: "溯江区",
    plate: "溯江新城板块",
    median: 17250,
    avg: 17620,
    p25: 16100,
    p75: 18900,
    sample: 34,
    change30: 0,
    direction: "flat",
    status: "ok",
    source: "演示数据源A",
    collectedAt: "2026-11-10 06:10",
    statDate: "2026-11-10",
    quality: "B",
    series: seriesAll(17250, 0, 0.005),
    sampleDelta: { added: 4, reduced: 4, removed: 2 },
  },
  {
    id: "qingchuan-xincun",
    name: "晴川新村（演示）",
    regionId: "qingchuan",
    regionName: "晴川区",
    plate: "老城板块",
    median: 15800,
    avg: 16050,
    p25: 14900,
    p75: 17100,
    sample: 7,
    change30: -3.5,
    direction: "down",
    status: "low",
    source: "演示数据源B",
    collectedAt: "2026-11-10 06:12",
    statDate: "2026-11-10",
    quality: "C",
    series: seriesAll(16370, -0.02, 0.02),
    sampleDelta: { added: 2, reduced: 3, removed: 1 },
  },
  {
    id: "yunlan-gongyu",
    name: "云澜公馆（演示）",
    regionId: "yunlan",
    regionName: "云澜区",
    plate: "云澜湾板块",
    median: null,
    avg: null,
    p25: null,
    p75: null,
    sample: 3,
    change30: 0,
    direction: "flat",
    status: "none",
    source: "演示数据源A",
    collectedAt: "2026-11-10 06:10",
    statDate: "2026-11-10",
    quality: "C",
    series: {},
    sampleDelta: { added: 1, reduced: 1, removed: 0 },
  },
];

const events: DemoEvent[] = [
  {
    id: "E-20261110-001",
    level: "high",
    type: "目标价首次达成",
    target: "晴川花园（演示）",
    targetType: "小区",
    before: 21400,
    after: 20480,
    direction: "down",
    deltaAmount: 920,
    deltaPct: 4.3,
    statDate: "2026-11-10",
    source: "演示数据源A",
    sample: 12,
    quality: "B",
    read: false,
    explanation:
      "挂牌中位价连续 3 期下调，累计降幅超过规则阈值 4%，首次低于目标价。",
    evidence: [
      "11-08 中位价 21,400 元/㎡（样本 14）",
      "11-09 中位价 21,050 元/㎡（样本 13）",
      "11-10 中位价 20,480 元/㎡（样本 12）",
      "口径：挂牌参考 · 数据来源：演示数据源A · 质量等级 B",
    ],
  },
  {
    id: "E-20261110-002",
    level: "mid",
    type: "连续降价",
    target: "云澜名邸（演示）",
    targetType: "小区",
    before: 20060,
    after: 19760,
    direction: "down",
    deltaAmount: 300,
    deltaPct: 1.5,
    statDate: "2026-11-08",
    source: "演示数据源B",
    sample: 46,
    quality: "A",
    read: false,
    explanation: "近 7 日内第 2 次整体降价，样本量充足，信号可信度较高。",
    evidence: [
      "11-06 中位价 20,060 元/㎡（样本 48）",
      "11-08 中位价 19,760 元/㎡（样本 46）",
      "口径：挂牌参考 · 数据来源：演示数据源B · 质量等级 A",
    ],
  },
  {
    id: "E-20261109-003",
    level: "low",
    type: "数据源延迟",
    target: "演示数据源·北站",
    targetType: "数据源",
    before: 0,
    after: 0,
    direction: "flat",
    deltaAmount: 0,
    deltaPct: 0,
    statDate: "2026-11-08",
    source: "演示数据源·北站",
    sample: 0,
    quality: "C",
    read: false,
    explanation:
      "该数据源已超过预期更新时间 2 天，相关指标显示“数据延迟”，不代表价格下跌。",
    evidence: [
      "预期更新：每日 06:00",
      "最后有效数据：2026-11-08",
      "处理：已触发重试，等待源恢复",
    ],
  },
  {
    id: "E-20261108-004",
    level: "mid",
    type: "区域价格异常",
    target: "晴川区",
    targetType: "区域",
    before: 21620,
    after: 21800,
    direction: "up",
    deltaAmount: 180,
    deltaPct: 0.8,
    statDate: "2026-11-08",
    source: "演示数据源A",
    sample: 126,
    quality: "B",
    read: true,
    explanation:
      "单日涨幅超过同口径历史波动区间，可能由高价样本占比变化导致，仅供参考。",
    evidence: [
      "同口径 90 日波动区间：-0.6% ~ +0.5%",
      "本次：+0.8%（样本 126，结构变化 +11%）",
      "口径：挂牌参考 · 来源：演示数据源A",
    ],
  },
];

const watchItems: DemoWatchItem[] = [
  {
    id: "W-001",
    name: "晴川花园（演示）",
    type: "小区",
    metric: "挂牌中位价",
    current: 21400,
    target: 20500,
    unit: "元/㎡",
    direction: "up",
    statDate: "2026-11-10",
    collectedAt: "2026-11-10 06:10",
    sample: 12,
    quality: "B",
    paused: false,
    triggered: false,
    lastEvent: "较目标价仍高 4.4%，持续观察",
    progress: 61,
  },
  {
    id: "W-002",
    name: "云澜区（演示）",
    type: "区域",
    metric: "挂牌中位价",
    current: 19400,
    target: 19600,
    unit: "元/㎡",
    direction: "down",
    statDate: "2026-11-10",
    collectedAt: "2026-11-10 06:10",
    sample: 88,
    quality: "B",
    paused: false,
    triggered: true,
    lastEvent: "目标价达成（低于目标 1.0%）",
    progress: 100,
  },
  {
    id: "W-003",
    name: "晴川新村（演示）",
    type: "小区",
    metric: "挂牌总价",
    current: 126,
    target: 120,
    unit: "万元",
    direction: "down",
    statDate: "2026-11-10",
    collectedAt: "2026-11-10 06:12",
    sample: 7,
    quality: "C",
    paused: true,
    triggered: false,
    lastEvent: "已暂停，不再产生新事件",
    progress: 45,
  },
];

const rules: DemoRule[] = [
  {
    id: "R-001",
    target: "晴川花园（演示）· 小区",
    metric: "挂牌中位价",
    condition: "单价 ≤ 20,500 元/㎡（当前 21,400，差 4.4%）",
    channels: ["每日摘要", "目标价触发邮件", "站内事件"],
    enabled: true,
    updatedAt: "2026-11-09",
  },
  {
    id: "R-002",
    target: "云澜区（演示）· 区域",
    metric: "挂牌中位价",
    condition: "较上期跌幅 ≥ 1.0%（当前 -1.2%，已触发）",
    channels: ["站内事件"],
    enabled: true,
    updatedAt: "2026-11-10",
  },
  {
    id: "R-003",
    target: "溯江雅苑（演示）· 小区",
    metric: "挂牌单价",
    condition: "单价 ≤ 16,800 元/㎡（当前 17,250，差 2.7%）",
    channels: ["每日摘要"],
    enabled: false,
    updatedAt: "2026-11-05",
  },
];

export interface DemoData {
  city: DemoCity;
  freshness: DemoFreshness;
  stale: DemoStale;
  /** 全市市场摘要（两个口径分别呈现） */
  cityMarket: {
    listMedian: number;
    listChange: number;
    listSample: number;
    dealMedian: number;
    dealChange: number;
    dealSample: number;
    series: Record<string, number[]>;
    dealSeries: Record<string, number[]>;
  };
  regions: DemoRegion[];
  communities: DemoCommunity[];
  events: DemoEvent[];
  watchItems: DemoWatchItem[];
  rules: DemoRule[];
  admin: {
    metrics: { label: string; value: string; hint: string }[];
    rows: DemoAdminRow[];
  };
  briefing: {
    days: { date: string; summary: string; bullets: string[] }[];
  };
}

export const demoData: DemoData = {
  city: {
    name: "演示市",
    code: "DEMO-0001",
    status: "active",
    note: "虚构试点城市，仅用于界面演示",
  },
  freshness: {
    lastSuccess: "2026-11-10 06:10",
    communities: 128,
    delayedSources: 2,
  },
  stale: {
    source: "演示数据源·北站",
    lastValid: "2026-11-08",
    days: 2,
  },
  cityMarket: {
    listMedian: 18600,
    listChange: -1.4,
    listSample: 412,
    dealMedian: 16900,
    dealChange: -2.1,
    dealSample: 92,
    series: seriesAll(18900, -0.007, 0.008),
    dealSeries: seriesAll(17300, -0.01, 0.01),
  },
  regions,
  communities,
  events,
  watchItems,
  rules,
  admin: {
    metrics: [
      { label: "覆盖小区", value: "128", hint: "演示市 · 已核验对象" },
      { label: "延迟数据源", value: "2", hint: "超过预期更新时间" },
      { label: "待审核对象", value: "15", hint: "目录补录申请" },
      { label: "今日事件", value: "8", hint: "含 1 条高优先级" },
    ],
    rows: [
      {
        id: "C-001",
        object: "晴川花园（演示）",
        type: "小区",
        status: "正常",
        sample: 12,
        updated: "2026-11-10",
        source: "演示数据源A",
        owner: "系统",
      },
      {
        id: "C-002",
        object: "云澜名邸（演示）",
        type: "小区",
        status: "正常",
        sample: 46,
        updated: "2026-11-08",
        source: "演示数据源B",
        owner: "系统",
      },
      {
        id: "C-003",
        object: "云澜公馆（演示）",
        type: "小区",
        status: "待审核",
        sample: 3,
        updated: "2026-11-10",
        source: "演示数据源A",
        owner: "目录申请",
      },
      {
        id: "C-004",
        object: "晴川区（演示）",
        type: "区域",
        status: "正常",
        sample: 126,
        updated: "2026-11-10",
        source: "演示数据源A",
        owner: "系统",
      },
      {
        id: "C-005",
        object: "溯江区（演示）",
        type: "区域",
        status: "已停用",
        sample: 41,
        updated: "2026-11-06",
        source: "演示数据源·北站",
        owner: "管理员",
      },
      {
        id: "C-006",
        object: "晴川新村（演示）",
        type: "小区",
        status: "待审核",
        sample: 7,
        updated: "2026-11-10",
        source: "演示数据源B",
        owner: "目录申请",
      },
    ],
  },
  briefing: {
    days: [
      {
        date: "2026-11-10",
        summary: "演示市整体挂牌中位价小幅下降，1 个监控对象触发目标价。",
        bullets: [
          "晴川区挂牌中位价 21,800 元/㎡，较上期 ▲上涨 0.8%（样本 126，口径：挂牌参考）",
          "云澜区挂牌中位价 19,400 元/㎡，较上期 ▼下降 1.2%（样本 88，口径：挂牌参考）",
          "目标价达成：云澜区（演示）低于目标 1.0%，见事件 E-20261110-001 系列",
          "数据延迟：演示数据源·北站最后有效数据 2026-11-08，相关指标已标注",
        ],
      },
      {
        date: "2026-11-09",
        summary: "无目标价触发；两个数据源正常更新。",
        bullets: [
          "晴川区挂牌中位价 21,620 元/㎡，较上期 ▲上涨 0.3%（样本 124）",
          "云澜区挂牌中位价 19,640 元/㎡，较上期 ▼下降 0.6%（样本 87）",
          "新增监控对象 1 个：晴川花园（演示）",
        ],
      },
    ],
  },
};
