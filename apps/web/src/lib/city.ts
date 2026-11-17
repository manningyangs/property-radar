// TASK-08C：游客城市范围（City Scope）——localStorage `pr_city` 持久化 + 订阅式广播。
// 纪律：只做目录元数据的读取/选择，绝不携带或伪造价格；无 active 城市时全站诚实空态。

/** 已选城市范围（与 /public/cities 行对齐的最小集） */
export interface CityScope {
  city_code: string;
  name: string;
  status: string;
}

export const CITY_STORAGE_KEY = "pr_city";
/** 城市切换广播事件（detail: CityScope | null） */
export const CITY_CHANGE_EVENT = "app:city-change";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function resolveStorage(): StorageLike | null {
  try {
    return typeof globalThis.localStorage !== "undefined"
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** 校验存储值形态：非法/缺失一律视为未选择（返回 null，不抛错） */
export function parseCityScope(raw: unknown): CityScope | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const cityCode = obj.city_code;
  const name = obj.name;
  const status = obj.status;
  if (
    typeof cityCode !== "string" ||
    cityCode.trim() === "" ||
    typeof name !== "string" ||
    name.trim() === "" ||
    typeof status !== "string"
  ) {
    return null;
  }
  return { city_code: cityCode, name, status };
}

/** 读取已选城市（JSON 损坏/形态非法 → null） */
export function readStoredCity(storage?: StorageLike | null): CityScope | null {
  const s = storage === undefined ? resolveStorage() : storage;
  if (!s) return null;
  const raw = s.getItem(CITY_STORAGE_KEY);
  if (!raw) return null;
  try {
    return parseCityScope(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 写入已选城市（存储不可用时静默失败——页面仍可用内存值渲染） */
export function writeStoredCity(
  city: CityScope,
  storage?: StorageLike | null,
): void {
  const s = storage === undefined ? resolveStorage() : storage;
  if (!s) return;
  s.setItem(CITY_STORAGE_KEY, JSON.stringify(city));
}

/** 目录默认城市：第一个 active（后端按名称排序）；无 active → null（全站空态） */
export function pickDefaultCity(cities: CityScope[]): CityScope | null {
  return cities.find((city) => city.status === "active") ?? null;
}

/** 是否已接入真实行情（active/limited 可展示数据；requestable 只能申请覆盖） */
export function isCityCovered(status: string): boolean {
  return status === "active" || status === "limited";
}

/** 城市状态徽章（与 CityScopeBadge 既有文案/色调一致） */
export function cityStatusBadge(status: string): {
  text: string;
  tone: "badge--primary" | "badge--neutral" | "badge--warning";
} {
  if (status === "active")
    return { text: "已开通 · 可监控", tone: "badge--primary" };
  if (status === "limited")
    return { text: "部分覆盖 · 可监控", tone: "badge--warning" };
  return { text: "未覆盖 · 可申请", tone: "badge--neutral" };
}

/** 徽标元素文本/色调统一渲染（CityScopeBadge 与页面共用，避免两处口径漂移） */
export function renderBadgeText(el: HTMLElement, city: CityScope | null): void {
  if (!city) {
    el.textContent = "337 城可申请";
    el.className = "badge city-status badge--neutral";
    return;
  }
  const { text, tone } = cityStatusBadge(city.status);
  el.textContent = text;
  el.className = `badge city-status ${tone}`;
}

/** 设置城市：持久化 + 广播 app:city-change（页面据此重新拉数据） */
export function applyCity(city: CityScope): void {
  writeStoredCity(city);
  if (
    typeof window !== "undefined" &&
    typeof window.dispatchEvent === "function"
  ) {
    window.dispatchEvent(new CustomEvent(CITY_CHANGE_EVENT, { detail: city }));
  }
}

/** 确定当前范围：已选城市优先；否则取目录第一个 active 并持久化；目录无 active → null */
export function resolveCityScope(
  cities: CityScope[],
  storage?: StorageLike | null,
): CityScope | null {
  const stored = readStoredCity(storage);
  if (stored) {
    // 已选城市必须仍在目录中（防止目录变更后的陈旧值）
    const fresh = cities.find((c) => c.city_code === stored.city_code);
    return fresh ? { ...stored, status: fresh.status } : stored;
  }
  const fallback = pickDefaultCity(cities);
  if (fallback) writeStoredCity(fallback, storage);
  return fallback;
}
