// TASK-03A：前端共享 API 客户端——统一请求前缀、会话 Cookie、错误信封解析与 401 跳转。
// 约定（spec 第 3 节）：
//   1) 所有请求携带 credentials:"include"，会话由 HttpOnly Cookie 承载；
//   2) 错误信封兼容后端两种形态：{ error_code, message, request_id } 与 { error: { code, message } }；
//   3) 受保护资源 401 → 跳转 /login?next=<当前路径>（登录端点自身不跳转，避免验证码错误打断表单）；
//   4) 只做数据搬运，不写入任何演示/伪造数据。

export const API_BASE: string =
  (import.meta.env.PUBLIC_API_BASE as string | undefined) ||
  "http://localhost:8789/api/v1";

/** 携带稳定错误码的 API 错误（status=0 表示网络层失败） */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ObjectType = "region" | "community" | "listing";
export type WatchStatus = "active" | "paused" | "archived";

/** 监控对象（item 响应；group_name/auto_monitoring 03A，规则摘要 03B） */
export interface WatchItem {
  watch_id: string;
  object_type: string;
  object_id: string;
  display_name_snapshot: string;
  priority: number;
  status: string;
  created_at: string;
  updated_at: string;
  group_name?: string | null;
  auto_monitoring?: boolean;
  /** 03B：已启用规则数（卡片“规则状态行”） */
  enabled_rule_count: number;
  /** 03B：最新已启用规则摘要（卡片“目标值”，无启用规则为 null） */
  rule_highlight: RuleHighlight | null;
}

/** 03B：规则摘要高亮（由 GET /me/watch-items 携带） */
export interface RuleHighlight {
  rule_id: string;
  rule_type: string;
  metric_code: string;
  price_type: string | null;
  target_value: number | null;
  unit: string | null;
  threshold_pct: number | null;
}

/** 03B：监控规则（含有效期/每规则通知渠道/触发状态/版本） */
export interface Rule {
  rule_id: string;
  watch_id: string;
  rule_type: string;
  metric_code: string;
  price_type: string | null;
  target_value: number | null;
  currency: string;
  unit: string | null;
  window_days: number | null;
  threshold_pct: number | null;
  hysteresis_pct: number | null;
  is_enabled: number;
  armed_state: string;
  version: number;
  created_at: string;
  updated_at: string;
  valid_until: string | null;
  notify_email: boolean;
  notify_digest: boolean;
  notify_inapp: boolean;
  is_expired: boolean;
}

export interface ListWatchItemsParams {
  status?: string;
  object_type?: string;
  group_name?: string;
  sort?: "created_at" | "priority";
  order?: "asc" | "desc";
}

export interface CreateWatchItemInput {
  object_type: ObjectType;
  object_id: string;
  display_name_snapshot: string;
  priority?: number;
  /** 可选分组名（1–50 字符），创建时入组 */
  group_name?: string;
}

export interface PatchWatchItemInput {
  display_name_snapshot?: string;
  priority?: number;
  status?: WatchStatus;
  /** 字符串 = upsert 分组；null = 移出分组 */
  group_name?: string | null;
}

export interface SessionUser {
  user_id: string;
  email: string;
  status: string;
  email_verified_at?: string | null;
  created_at?: string;
  last_login_at?: string | null;
}

interface RequestOptions extends RequestInit {
  /** 401 时是否跳转登录页（登录端点传 true，验证码错误不应打断表单） */
  skipAuthRedirect?: boolean;
}

interface ErrorEnvelope {
  error_code?: string;
  message?: string;
  error?: { code?: string; message?: string };
  /** 400 校验错误的字段级明细（03B 绑定校验的中文文案在此） */
  details?: Array<{ field?: string; message?: string }>;
}

/** 统一请求：解析 JSON、错误信封抛 ApiError、401 统一跳登录 */
async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { skipAuthRedirect = false, headers, ...init } = options;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(
      0,
      "network_error",
      "网络异常，无法连接服务，请稍后重试",
    );
  }

  // 401 → 统一跳登录并携带回跳地址（已在登录页时不跳，避免打断登录表单）
  if (
    res.status === 401 &&
    !skipAuthRedirect &&
    !window.location.pathname.startsWith("/login")
  ) {
    const next = window.location.pathname + window.location.search;
    window.location.href = `/login?next=${encodeURIComponent(next)}`;
    throw new ApiError(401, "unauthorized", "登录已过期，请重新登录");
  }

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 响应（如网关错误页），按状态码处理
    }
  }

  if (!res.ok) {
    const envelope = (body ?? {}) as ErrorEnvelope;
    const code =
      envelope.error_code ?? envelope.error?.code ?? `http_${res.status}`;
    const detail = envelope.details?.[0]?.message;
    const message =
      envelope.error?.message ??
      detail ??
      envelope.message ??
      `请求失败（HTTP ${res.status}）`;
    throw new ApiError(res.status, code, message);
  }
  return body as T;
}

// ---------------- 认证 ----------------

/** POST /auth/email/request-code——请求邮箱验证码（含 Turnstile 令牌） */
export function requestCode(
  email: string,
  turnstileToken: string,
): Promise<{ status: string; message: string }> {
  return request("/auth/email/request-code", {
    method: "POST",
    body: JSON.stringify({ email, turnstile_token: turnstileToken }),
    skipAuthRedirect: true,
  });
}

/** POST /auth/email/verify-code——校验验证码并建立会话 */
export function verifyCode(
  email: string,
  code: string,
): Promise<{ user: SessionUser }> {
  return request("/auth/email/verify-code", {
    method: "POST",
    body: JSON.stringify({ email, code }),
    skipAuthRedirect: true,
  });
}

/** POST /auth/logout——撤销当前会话（幂等） */
export function logout(): Promise<{ logged_out: boolean }> {
  return request("/auth/logout", {
    method: "POST",
    skipAuthRedirect: true,
  });
}

/** GET /auth/me——当前用户资料（401 时按统一策略跳登录） */
export function getMe(): Promise<{ user: SessionUser }> {
  return request("/auth/me");
}

// ---------------- 监控对象 ----------------

/** GET /me/watch-items——按状态/类型/分组筛选与排序查询监控列表 */
export function listWatchItems(
  params: ListWatchItemsParams = {},
): Promise<{ items: WatchItem[]; count: number }> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.object_type) query.set("object_type", params.object_type);
  if (params.group_name) query.set("group_name", params.group_name);
  if (params.sort) query.set("sort", params.sort);
  if (params.order) query.set("order", params.order);
  const qs = query.toString();
  return request(`/me/watch-items${qs ? `?${qs}` : ""}`);
}

/** POST /me/watch-items——添加监控对象（重复对象后端返回 409 conflict） */
export function createWatchItem(
  input: CreateWatchItemInput,
): Promise<{ item: WatchItem }> {
  return request("/me/watch-items", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** PATCH /me/watch-items/:id——更新状态/优先级/名称/分组 */
export function patchWatchItem(
  id: string,
  patch: PatchWatchItemInput,
): Promise<{ item: WatchItem }> {
  return request(`/me/watch-items/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** DELETE /me/watch-items/:id——删除监控对象（关联规则/分组级联消失） */
export function deleteWatchItem(id: string): Promise<{ deleted: boolean }> {
  return request(`/me/watch-items/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---------------- 监控规则（TASK-03B） ----------------

export interface CreateRuleInput {
  rule_type: string;
  metric_code: string;
  price_type: string;
  target_value?: number | null;
  unit?: string | null;
  window_days?: number | null;
  threshold_pct?: number | null;
  hysteresis_pct?: number | null;
  currency?: string;
  is_enabled?: boolean;
  valid_until?: string | null;
  notify_email?: boolean;
  notify_digest?: boolean;
  notify_inapp?: boolean;
}

export interface PatchRuleInput {
  rule_type?: string;
  metric_code?: string;
  price_type?: string;
  target_value?: number | null;
  unit?: string | null;
  window_days?: number | null;
  threshold_pct?: number | null;
  hysteresis_pct?: number | null;
  currency?: string;
  is_enabled?: boolean;
  valid_until?: string | null;
  notify_email?: boolean;
  notify_digest?: boolean;
  notify_inapp?: boolean;
}

/** GET /me/watch-items/:id/rules——某监控对象的规则列表 */
export function listRules(
  watchId: string,
): Promise<{ items: Rule[]; count: number }> {
  return request(`/me/watch-items/${encodeURIComponent(watchId)}/rules`);
}

/** POST /me/watch-items/:id/rules——创建规则（绑定非法后端 400 拦截） */
export function createRule(
  watchId: string,
  input: CreateRuleInput,
): Promise<{ item: Rule }> {
  return request(`/me/watch-items/${encodeURIComponent(watchId)}/rules`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** PATCH /me/rules/:id——改目标/口径/有效期/渠道/启停（内容变更 version+1） */
export function patchRule(
  id: string,
  patch: PatchRuleInput,
): Promise<{ item: Rule }> {
  return request(`/me/rules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** DELETE /me/rules/:id——删除规则（设置行级联消失） */
export function deleteRule(id: string): Promise<{ deleted: boolean }> {
  return request(`/me/rules/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ---------------- 公共目录（添加监控流程的数据源） ----------------

export interface CityItem {
  city_code: string;
  name: string;
  province_code: string;
  status: string;
  catalog_status: string;
  coverage_level?: string | null;
  coverage_note?: string | null;
}

export interface RegionItem {
  region_id: string;
  city_code: string;
  name: string;
  level: string;
  is_active: number;
}

export interface CommunityItem {
  community_id: string;
  city_code: string;
  region_id: string;
  name: string;
  block_name?: string | null;
  built_year?: number | null;
  status: string;
}

/** GET /public/cities?q=——城市目录搜索（未覆盖城市同样可选） */
export function searchCities(
  q = "",
): Promise<{ items: CityItem[]; count: number }> {
  const query = q ? `?q=${encodeURIComponent(q)}` : "";
  return request(`/public/cities${query}`);
}

/** GET /public/regions?city_code=&q=——行政区域搜索 */
export function searchRegions(
  cityCode: string,
  q = "",
): Promise<{ items: RegionItem[]; count: number }> {
  const query = new URLSearchParams();
  if (cityCode) query.set("city_code", cityCode);
  if (q) query.set("q", q);
  return request(`/public/regions?${query.toString()}`);
}

/** GET /public/communities?region_id=&q=——小区搜索 */
export function searchCommunities(
  regionId: string,
  q = "",
): Promise<{ items: CommunityItem[]; count: number }> {
  const query = new URLSearchParams();
  if (regionId) query.set("region_id", regionId);
  if (q) query.set("q", q);
  return request(`/public/communities?${query.toString()}`);
}
