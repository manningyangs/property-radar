// TASK-05A：站内事件展示共享映射（事件中心 /events 与首页「今日与我有关」共用）。
// 级别、中文标签、时间格式统一于此；事件数值与解释文案一律取 API 字段，前端不造数。
export type EventLevel = "high" | "mid" | "low";

/** 四类事件中文标签（与后端 EVENT_TYPES 枚举一一对应） */
export const EVENT_TYPE_LABELS: Record<string, string> = {
  target_price_reached: "目标价首次达成",
  price_drop: "窗口期降价",
  data_anomaly: "数据异常",
  update_delayed: "更新延迟",
};

/** 事件类型 → 展示标签（未知类型原样透传，不臆造文案） */
export function eventLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? type;
}

/** 级别映射（spec R5）：目标价达成=高；降价/异常=中；更新延迟=低 */
export function eventLevel(type: string): EventLevel {
  if (type === "target_price_reached") return "high";
  if (type === "update_delayed") return "low";
  return "mid";
}

/** 级别徽标文字（与 EventTimelineItem 级别徽标一致） */
export const EVENT_LEVEL_TEXT: Record<EventLevel, string> = {
  high: "高",
  mid: "中",
  low: "低",
};

/** 级别徽标样式（与 base.css badge 修饰类一致） */
export const EVENT_LEVEL_CLASS: Record<EventLevel, string> = {
  high: "badge--danger",
  mid: "badge--warning",
  low: "badge--neutral",
};

/**
 * 解析事件时间：后端 created_at/read_at 为 SQLite datetime('now')
 * （UTC、无时区后缀），按 UTC 语义补 Z 解析，避免被 JS 误当本地时间。
 */
export function parseEventTime(iso: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  if (!hasZone && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(iso)) {
    return new Date(`${iso.replace(" ", "T")}Z`);
  }
  return new Date(iso);
}

/** Asia/Shanghai 挂钟（固定 UTC+8，无夏令时）；非法时间返回 null */
function shanghaiParts(
  iso: string,
): { date: string; clock: string; full: string } | null {
  const date = parseEventTime(iso);
  if (Number.isNaN(date.getTime())) return null;
  const shifted = new Date(date.getTime() + 8 * 3_600_000).toISOString();
  return {
    date: shifted.slice(0, 10),
    clock: shifted.slice(11, 16),
    full: `${shifted.slice(0, 10)} ${shifted.slice(11, 16)}`,
  };
}

/** 事件时间 → Asia/Shanghai 本地 "YYYY-MM-DD HH:mm"（非法值原样返回） */
export function formatEventTime(iso: string): string {
  return shanghaiParts(iso)?.full ?? iso;
}

/** 事件时间 → Asia/Shanghai 时钟 "HH:mm" */
export function formatEventClock(iso: string): string {
  return shanghaiParts(iso)?.clock ?? iso;
}

/** 事件时间 → Asia/Shanghai 当日 "YYYY-MM-DD"（首页今日筛选） */
export function eventShanghaiDate(iso: string): string {
  return shanghaiParts(iso)?.date ?? "";
}

/** 当前 Asia/Shanghai 当日 "YYYY-MM-DD" */
export function todayShanghaiDate(now: Date = new Date()): string {
  return shanghaiParts(now.toISOString())?.date ?? "";
}

/** 样本分层文案（与 SampleCountLabel 阈值一致：≥20 / 10–19 / 5–9 / <5） */
export function sampleTierText(sample: number): string {
  if (sample >= 20) return "样本相对充足";
  if (sample >= 10) return "样本有限";
  if (sample >= 5) return "低样本，仅供观察";
  return "数据不足";
}
