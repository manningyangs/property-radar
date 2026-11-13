// TASK-05B R1.2/R2.3：邮件正文构造（PRD 任务行 1332 九要素）。
// 红线：正文只出现展示就绪的中文文案（对象/指标中文名/目标/当前/价差/日期/来源/样本量/链接），
// 绝不出现内部字段名、表名、列名或原始 source_id（如 metric_code、difference_pct、src_*）。
import type { DigestMail, EventMailContent } from "./provider";

/** 四类事件中文标签（镜像 apps/web/src/lib/events.ts，服务端不依赖前端包） */
export const EVENT_TYPE_LABELS: Record<string, string> = {
  target_price_reached: "目标价首次达成",
  price_drop: "窗口期降价",
  data_anomaly: "数据异常",
  update_delayed: "更新延迟",
};

/** 系统事件无价格指标时的指标名（对应其解释语义，不臆造数值） */
const SYSTEM_METRIC_LABELS: Record<string, string> = {
  data_anomaly: "数据质量",
  update_delayed: "数据更新时效",
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 带符号数值（价差展示：−500 / +300） */
function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export interface EventMailInput {
  eventType: string;
  /** alert_events 行数值 */
  values: {
    oldValue: number | null;
    newValue: number | null;
    targetValue: number | null;
    differencePct: number | null;
  };
  evidence: Record<string, unknown>;
  /** 来源展示名（调用方查 data_sources_public.name 或取 evidence.source_name，缺省“未知”） */
  sourceName: string;
  /** 前端站点根地址（邮件内页链接） */
  webBase: string;
}

/** 事件邮件正文（price_alert）：九要素齐全、零内部字段名 */
export function buildEventMailContent(input: EventMailInput): EventMailContent {
  const { evidence, values } = input;
  const typeLabel = EVENT_TYPE_LABELS[input.eventType] ?? "事件提醒";
  const objectName = str(evidence.display_name) ?? "监控对象";
  const metricName =
    str(evidence.metric_label) ?? SYSTEM_METRIC_LABELS[input.eventType] ?? "—";
  const unit = str(evidence.unit) ?? "元/㎡";
  const target = num(values.targetValue);
  const threshold = num(evidence.threshold_pct);
  const current = num(values.newValue);
  const baseline = num(evidence.baseline_value);
  const baselineDate = str(evidence.baseline_stat_date);
  const old = num(values.oldValue);
  const diffPct = num(values.differencePct);
  const targetGapPct =
    num(evidence.target_gap_pct) ??
    (target !== null && target !== 0 && current !== null
      ? round2(((current - target) / target) * 100)
      : null);

  let targetText = "—";
  if (target !== null) targetText = `${target} ${unit}`;
  else if (threshold !== null) targetText = `${threshold}%（跌幅阈值）`;

  let currentText = "—";
  if (current !== null) currentText = `${current} ${unit}`;

  let gapText = "—";
  if (target !== null && current !== null) {
    gapText = `${signed(round2(current - target))} ${unit}（较目标 ${targetGapPct ?? "—"}%）`;
  } else if (baseline !== null && current !== null) {
    const diff = round2(current - baseline);
    const pct = diffPct ?? null;
    gapText = `${signed(diff)} ${unit}（${pct ?? "—"}%${baselineDate ? `，较 ${baselineDate}` : ""}）`;
  } else if (old !== null && current !== null && diffPct !== null) {
    gapText = `${signed(round2(current - old))} ${unit}（${diffPct}%）`;
  }

  const dateText =
    str(evidence.stat_date) ?? str(evidence.latest_stat_date) ?? "—";
  const samples = num(evidence.sample_count);
  const link = `${input.webBase.replace(/\/+$/, "")}/events`;

  return {
    subject: `房价雷达·${typeLabel}：${objectName}`,
    object_name: objectName,
    metric_name: metricName,
    target: targetText,
    current: currentText,
    gap: gapText,
    date: dateText,
    source: input.sourceName,
    samples: samples !== null ? `${samples} 条` : "—",
    link,
  };
}

// ---------------- 每日摘要（R2.3） ----------------

/** 事件级别（镜像 apps/web/src/lib/events.ts：目标价=高、延迟=低、其余=中） */
function eventLevel(eventType: string): "high" | "mid" | "low" {
  if (eventType === "target_price_reached") return "high";
  if (eventType === "update_delayed") return "low";
  return "mid";
}

const LEVEL_LABELS: Record<string, string> = {
  high: "高",
  mid: "中",
  low: "低",
};

export interface DigestMailInput {
  /** 摘要覆盖的北京日（发件日的上一日） */
  digestDate: string;
  /** 上一北京日的事件（已按时间序） */
  events: Array<{
    eventType: string;
    objectName: string;
    explanation: string;
  }>;
  unreadCount: number;
  monitorCount: number;
  webBase: string;
}

/** 每日摘要正文（daily_digest）：价格变化/事件/监控与数据状态概述 + 事件明细 + 链接，零内部字段名 */
export function buildDigestMailContent(
  input: DigestMailInput,
): Omit<DigestMail, "to"> {
  const counts: Record<string, number> = {};
  for (const e of input.events) {
    counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
  }
  const priceCount =
    (counts.target_price_reached ?? 0) + (counts.price_drop ?? 0);
  const anomalyCount = counts.data_anomaly ?? 0;
  const delayedCount = counts.update_delayed ?? 0;
  const total = input.events.length;
  const top: "high" | "mid" | "low" = input.events.some(
    (e) => eventLevel(e.eventType) === "high",
  )
    ? "high"
    : input.events.some((e) => eventLevel(e.eventType) === "mid")
      ? "mid"
      : "low";
  const link = `${input.webBase.replace(/\/+$/, "")}/events`;

  const summary_lines = [
    priceCount > 0
      ? `昨日价格变化：目标价首次达成 ${counts.target_price_reached ?? 0} 条 · 窗口期降价 ${counts.price_drop ?? 0} 条`
      : "昨日价格变化：无价格类事件",
    `昨日事件共 ${total} 条（未读 ${input.unreadCount} 条），最高级别：${LEVEL_LABELS[top]}`,
    `监控状态：在监控 ${input.monitorCount} 个对象`,
    anomalyCount + delayedCount > 0
      ? `数据状态：${anomalyCount} 条数据异常 · ${delayedCount} 条更新延迟（明细见下方与事件中心）`
      : "数据状态：暂无数据异常或更新延迟",
  ];

  return {
    subject: `房价雷达每日摘要 · ${input.digestDate}（昨日 ${total} 条新事件）`,
    date: input.digestDate,
    summary_lines,
    event_rows: input.events.map((e) => ({
      object_name: e.objectName,
      type_label: EVENT_TYPE_LABELS[e.eventType] ?? "事件提醒",
      change_summary: e.explanation,
      link,
    })),
    link,
  };
}
