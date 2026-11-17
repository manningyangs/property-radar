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

/** GET /auth/me——当前用户资料（401 默认跳登录；账户页传 skipAuthRedirect 按游客渲染） */
export function getMe(
  skipAuthRedirect = false,
): Promise<{ user: SessionUser }> {
  return request("/auth/me", { skipAuthRedirect });
}

// ---------------- 数据合规（TASK-07B） ----------------

/** POST /me/export——导出个人数据（JSON 单文件；401 由调用方提示，不跳登录） */
export function exportData(): Promise<Record<string, unknown>> {
  return request("/me/export", {
    method: "POST",
    body: JSON.stringify({}),
    skipAuthRedirect: true,
  });
}

/** POST /me/delete-account——申请注销（冷静期 7 天，到期云端数据永久删除） */
export function deleteAccount(): Promise<{
  status: string;
  purge_after_days: number;
}> {
  return request("/me/delete-account", {
    method: "POST",
    body: JSON.stringify({ confirm: true }),
    skipAuthRedirect: true,
  });
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

// ---------------- 站内事件（TASK-05A） ----------------

/** 事件证据（evidence_json 解析对象；字段可能缺失，前端按需容错取用） */
export interface AlertEventEvidence {
  /** 服务端生成的中文解释整句（前端不自造文案） */
  explanation?: string;
  /** 证据明细列表 */
  evidence_lines?: string[];
  /** 监控对象名 */
  display_name?: string;
  object_type?: string;
  quality_status?: string;
  quality_label?: string;
  stat_date?: string;
  source_id?: string;
  source_name?: string;
  latest_source_id?: string | null;
  sample_count?: number;
  metric_code?: string;
  unit?: string;
  rule_version?: number;
  target_value?: number;
  baseline_value?: number;
  drop_pct?: number;
  sla_days?: number;
  delay_days?: number;
  latest_stat_date?: string;
  trigger?: string;
  job_id?: string;
  error_code?: string;
  /** 其余服务端证据字段（透传容错） */
  [key: string]: unknown;
}

/** 站内事件（GET /me/events 的 items 元素，§2.8 字段全集） */
export interface AlertEvent {
  event_id: string;
  rule_id: string | null;
  watch_id: string | null;
  snapshot_id: string | null;
  event_type: string;
  old_value: number | null;
  new_value: number | null;
  target_value: number | null;
  difference_pct: number | null;
  evidence: AlertEventEvidence;
  status: "unread" | "read";
  created_at: string;
  read_at: string | null;
}

export interface ListEventsParams {
  /** true=只看未读（服务端过滤）；false/缺省=全部 */
  unread?: boolean;
  /** 1–50（后端缺省 20） */
  limit?: number;
  /** 事件类型枚举：target_price_reached/price_drop/data_anomaly/update_delayed */
  type?: string;
}

export interface ListEventsOptions {
  /** 401 时不跳登录（首页引导、导航角标等需自行降级的场景） */
  skipAuthRedirect?: boolean;
}

/** GET /me/events——事件列表（unread_count=当前用户未读总数，不受 limit/type 影响） */
export function listEvents(
  params: ListEventsParams = {},
  options: ListEventsOptions = {},
): Promise<{ items: AlertEvent[]; count: number; unread_count: number }> {
  const query = new URLSearchParams();
  if (params.unread !== undefined)
    query.set("unread", params.unread ? "true" : "false");
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.type) query.set("type", params.type);
  const qs = query.toString();
  return request(`/me/events${qs ? `?${qs}` : ""}`, {
    skipAuthRedirect: options.skipAuthRedirect ?? false,
  });
}

/** PATCH /me/events/:id/read——标记已读/未读（幂等；404=事件不存在） */
export function setEventRead(
  id: string,
  read: boolean,
): Promise<{
  event: { event_id: string; status: string; read_at: string | null };
}> {
  return request(`/me/events/${encodeURIComponent(id)}/read`, {
    method: "PATCH",
    body: JSON.stringify({ read }),
  });
}

/** 导航角标未读数（401/失败不跳转不抛扰——由调用方静默隐藏角标） */
export async function getUnreadEventCount(): Promise<number> {
  const res = await request<{ unread_count?: number }>(
    "/me/events?unread=true&limit=1",
    {
      skipAuthRedirect: true,
    },
  );
  return res.unread_count ?? 0;
}

// ---------------- 浏览器推送（TASK-05C） ----------------

export interface PushConfig {
  enabled: boolean;
  /** base64url P-256 应用服务器公钥（enabled=false 时缺省） */
  public_key?: string;
}

export interface PushSubscriptionCounts {
  count: number;
  active_count: number;
}

/** GET /public/push-config——订阅所需 VAPID 公钥（公开端点，401 不跳转） */
export function getPushConfig(): Promise<PushConfig> {
  return request("/public/push-config", { skipAuthRedirect: true });
}

/** GET /me/push-subscriptions——本人订阅聚合数（不回显 endpoint/密钥） */
export function getPushSubscriptionCounts(): Promise<PushSubscriptionCounts> {
  return request("/me/push-subscriptions", { skipAuthRedirect: true });
}

/** POST /me/push-subscriptions——upsert 订阅（返回 subscription_id，删除时需要） */
export function createPushSubscription(
  endpoint: string,
  keys: { p256dh: string; auth: string },
): Promise<{ subscription_id: string }> {
  return request("/me/push-subscriptions", {
    method: "POST",
    body: JSON.stringify({ endpoint, keys }),
  });
}

/** DELETE /me/push-subscriptions——按 subscription_id 删除（204 空体） */
export function deletePushSubscription(subscriptionId: string): Promise<null> {
  return request("/me/push-subscriptions", {
    method: "DELETE",
    body: JSON.stringify({ subscription_id: subscriptionId }),
  });
}

export interface NotificationPreferences {
  email_enabled: boolean;
  digest_enabled: boolean;
  digest_time: string;
  browser_push_enabled: boolean;
  timezone: string;
}

/** GET /me/notification-preferences——含 browser_push_enabled（未登录 401 不跳转） */
export function getNotificationPreferences(): Promise<{
  preferences: NotificationPreferences;
}> {
  return request("/me/notification-preferences", { skipAuthRedirect: true });
}

/** PATCH /me/notification-preferences——邮件/摘要/推送开关（登录后云端保存，跨设备同步） */
export function patchNotificationPreferences(patch: {
  browser_push_enabled?: boolean;
  email_enabled?: boolean;
  digest_enabled?: boolean;
}): Promise<{ preferences: NotificationPreferences }> {
  return request("/me/notification-preferences", {
    method: "PATCH",
    body: JSON.stringify(patch),
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
  updated_at?: string;
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

// ---------------- 管理后台：数据源中心（TASK-06C） ----------------

export interface MfaStatus {
  enrolled: boolean;
  confirmed: boolean;
  session_verified: boolean;
}

export interface MfaSetupResult {
  secret: string;
  otpauth_uri: string;
}

export interface AdminSourceCoverage {
  source_id: string;
  city_code: string;
  object_level: string;
  metric_codes_json: string;
  authorization_status: string;
  last_verified_at: string | null;
}

export interface AdminSourceItem {
  source_id: string;
  name: string;
  source_type: string;
  official_url: string | null;
  data_scope: string | null;
  license_note_url: string | null;
  display_scope: string | null;
  updated_at: string;
  last_verified_at: string | null;
  status: string;
  valid_until: string | null;
  is_expired: boolean;
  coverage: AdminSourceCoverage[];
  approval_count: number;
  health_status: string;
  last_success_at: string | null;
}

export interface ApprovalRecord {
  approval_id: string;
  source_id: string;
  action: string;
  approver_user_id: string;
  evidence_ref: string;
  permitted_fields: unknown[];
  permitted_purposes: unknown[];
  allowed_cities: unknown[];
  frequency: string;
  retention_period: string;
  valid_until: string | null;
  status_after: string;
  note: string | null;
  created_at: string;
}

export interface AuditLogItem {
  audit_id: string;
  actor_user_id: string;
  actor_role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface ApproveSourceInput {
  status: "approved_open" | "approved_licensed";
  evidence_ref: string;
  permitted_fields: string[];
  permitted_purposes: string[];
  frequency: string;
  retention_period: string;
  coverage: Array<{
    city_code: string;
    object_level: string;
    metric_codes: string[];
  }>;
  valid_until?: string | null;
  note?: string;
}

/** GET /admin/mfa/status（401 由 request 统一跳登录） */
export function adminMfaStatus(): Promise<MfaStatus> {
  return request("/admin/mfa/status");
}

/** POST /admin/mfa/setup：生成 TOTP 密钥（已绑定已确认时 409） */
export function adminMfaSetup(): Promise<MfaSetupResult> {
  return request("/admin/mfa/setup", { method: "POST", body: "{}" });
}

/** POST /admin/mfa/verify：校验 TOTP 并标记当前会话 */
export function adminMfaVerify(code: string): Promise<{ verified: boolean }> {
  return request("/admin/mfa/verify", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

/** GET /admin/sources：来源清单（含许可状态/覆盖/健康摘要） */
export function adminSourcesList(): Promise<{
  items: AdminSourceItem[];
  count: number;
}> {
  return request("/admin/sources");
}

/** POST /admin/sources：登记（一律 discovered，状态只能走审批端点） */
export function adminSourceCreate(input: {
  source_id: string;
  name: string;
  source_type: string;
  official_url?: string;
  data_scope?: string;
  license_note_url?: string;
  display_scope?: string;
}): Promise<{ source: AdminSourceItem }> {
  return request("/admin/sources", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** PATCH /admin/sources/:id：仅元数据编辑（status 出现即 400） */
export function adminSourcePatch(
  id: string,
  patch: Partial<
    Pick<
      AdminSourceItem,
      | "name"
      | "source_type"
      | "official_url"
      | "data_scope"
      | "license_note_url"
      | "display_scope"
    >
  >,
): Promise<{ source: AdminSourceItem }> {
  return request(`/admin/sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

/** POST /admin/sources/:id/approve：审批（非法状态转换 409——未审批不能启用的后端兜底） */
export function adminSourceApprove(
  id: string,
  input: ApproveSourceInput,
): Promise<{ source: AdminSourceItem }> {
  return request(`/admin/sources/${encodeURIComponent(id)}/approve`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** POST /admin/sources/:id/suspend：停用（恢复须重新审批） */
export function adminSourceSuspend(
  id: string,
  reason: string,
): Promise<{ source: AdminSourceItem; previous_status: string }> {
  return request(`/admin/sources/${encodeURIComponent(id)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

/** GET /admin/sources/:id/approvals：审批历史（append-only，不可无痕修改） */
export function adminSourceApprovals(
  id: string,
): Promise<{ items: ApprovalRecord[]; count: number }> {
  return request(`/admin/sources/${encodeURIComponent(id)}/approvals`);
}

/** GET /admin/audit?resource_type=data_source：来源操作审计（倒序） */
export function adminAuditForSource(): Promise<{
  items: AuditLogItem[];
  count: number;
}> {
  const query = new URLSearchParams({
    resource_type: "data_source",
    limit: "100",
  });
  return request(`/admin/audit?${query.toString()}`);
}

// ---------------- TASK-06D：任务和质量后台（§8.6 / §8.7 / 任务行 1368–1374） ----------------

/** GET /admin/jobs item：§8.6 全字段（04B 旧行新列为 null） */
export interface AdminJobItem {
  job_id: string;
  source_id: string;
  source_name: string;
  city_code: string;
  run_type: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error_code: string | null;
  note: string | null;
  records_fetched: number | null;
  records_accepted: number | null;
  records_rejected: number | null;
  communities_covered: number | null;
  connector_version: string | null;
  workflow_url: string | null;
}

export interface AdminJobsResult {
  items: AdminJobItem[];
  count: number;
  limit: number;
  offset: number;
  summary: {
    jobs_7d: { succeeded: number; failed: number; running: number };
    success_rate: number | null;
  };
}

export interface AdminJobsQuery {
  source_id?: string;
  status?: string;
  city_code?: string;
  q?: string;
  sort?: "started_at" | "finished_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/** GET /admin/jobs：采集任务日志（搜索/筛选/排序/分页 + 近 7 日摘要） */
export function adminJobsList(
  query: AdminJobsQuery = {},
): Promise<AdminJobsResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/admin/jobs${qs ? `?${qs}` : ""}`);
}

/** 质量异常统一形态（locator 随 issue_kind 变化——验收一定位要素） */
export interface QualityIssue {
  issue_kind: "job_failed" | "health" | "observation" | "snapshot";
  source_id: string;
  source_name: string;
  occurred_at: string;
  note: string | null;
  locator: Record<string, unknown>;
}

export interface QualityIssuesResult {
  items: QualityIssue[];
  count: number;
  limit: number;
  offset: number;
  counts: {
    job_failed: number;
    health: number;
    observation: number;
    snapshot: number;
  };
}

/** GET /admin/quality/issues：四类异常只读聚合（拍板 4，无写操作；
 *  snapshot=TASK-09 R3 双源中位数交叉核验离群快照） */
export function adminQualityIssues(
  query: {
    kind?: string;
    source_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<QualityIssuesResult> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/admin/quality/issues${qs ? `?${qs}` : ""}`);
}

/** GET /admin/overview（06B 既有块 + 06D ops 四指标块） */
export interface AdminOverviewResult {
  users: {
    total: number;
    active: number;
    frozen: number;
    new_7d: number;
    active_7d: number;
  };
  monitoring: {
    watches_active: number;
    by_object_type: Record<string, number>;
    rules_enabled: number;
  };
  events: { today: number; last_7d: number };
  email: {
    last_7d: {
      sent: number;
      provider_error: number;
      quota_deferred: number;
      success_rate: number | null;
    };
  };
  sources: { by_status: Record<string, number> };
  jobs: { today: Record<string, number> };
  snapshots: { today_valid: number };
  ops: {
    jobs_7d: { succeeded: number; failed: number; running: number };
    success_rate_7d: number | null;
    last_update_at: string | null;
    communities_covered: number;
    source_issue_count: number;
  };
}

/** GET /admin/overview：总览聚合（零 PII；ops 为 06D 四指标卡数据源） */
export function adminOverview(): Promise<AdminOverviewResult> {
  return request("/admin/overview");
}

// ---------------- TASK-08C：公共行情数据（游客只读，零演示数据） ----------------

export interface PublicCity {
  city_code: string;
  name: string;
  province_code: string;
  /** active/limited/requestable（CITY_STATUSES） */
  status: string;
  catalog_status: string;
  coverage_level?: string | null;
  coverage_note?: string | null;
  updated_at?: string;
}

/** GET /public/cities?q=&status=&limit= —— 城市目录（含覆盖状态） */
export function getPublicCities(
  params: { q?: string; status?: string; limit?: number } = {},
): Promise<{ items: PublicCity[]; count: number }> {
  const query = new URLSearchParams();
  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  const qs = query.toString();
  return request(`/public/cities${qs ? `?${qs}` : ""}`);
}

/** 价格快照（region summary 与 community prices 共用形态；prices 额外带来源字段） */
export interface PriceSnapshot {
  snapshot_id: string;
  price_type: string | null;
  metric_code: string;
  median: number | null;
  mean: number | null;
  p25: number | null;
  p75: number | null;
  sample_count: number | null;
  stat_date: string;
  quality_status: string;
  source_id?: string | null;
  collected_at?: string | null;
  method_version?: string | null;
}

export interface RegionInfo {
  region_id: string;
  parent_id: string | null;
  city_code: string;
  name: string;
  level: string;
  updated_at?: string;
}

/** GET /public/regions/:id/summary —— 区域最新指标快照（无数据如实空列表） */
export function getRegionSummary(
  regionId: string,
): Promise<{ region: RegionInfo; snapshots: PriceSnapshot[] }> {
  return request(`/public/regions/${encodeURIComponent(regionId)}/summary`);
}

export interface CommunityDetail {
  community_id: string;
  city_code: string;
  region_id: string;
  name: string;
  alias_json: string | null;
  address_coarse: string | null;
  block_name: string | null;
  built_year: number | null;
  longitude: number | null;
  latitude: number | null;
  status: string;
  updated_at: string;
}

/** 城市覆盖详情（GET /public/cities/:cityCode/coverage）：来源登记与授权状态 */
export interface CityCoverageDetail {
  city: PublicCity;
  coverage: Array<Record<string, unknown>>;
  updated_at?: string;
}

/** GET /public/cities/:cityCode/coverage —— 城市级覆盖、更新时间与来源登记 */
export function getCityCoverage(cityCode: string): Promise<CityCoverageDetail> {
  return request(`/public/cities/${encodeURIComponent(cityCode)}/coverage`);
}

/** GET /public/communities/:id —— 小区基础信息 */
export function getCommunity(
  communityId: string,
): Promise<{ community: CommunityDetail }> {
  return request(`/public/communities/${encodeURIComponent(communityId)}`);
}

/** GET /public/communities/:id/prices?limit= —— 小区历史价格快照（倒序） */
export function getCommunityPrices(
  communityId: string,
  limit?: number,
): Promise<{ items: PriceSnapshot[]; count: number }> {
  const qs = limit !== undefined ? `?limit=${limit}` : "";
  return request(
    `/public/communities/${encodeURIComponent(communityId)}/prices${qs}`,
  );
}

/** 逐小区覆盖结论（TASK-04D）：snapshot=null 表示该小区无有效快照，绝不造数 */
export interface CommunityCoverageItem {
  community_id: string;
  name: string;
  district: string | null;
  snapshot: {
    source_id: string;
    price_type: string | null;
    metric_code: string | null;
    sample_count: number | null;
    stat_date: string | null;
    collected_at: string | null;
    quality_status: string | null;
  } | null;
}

/** GET /public/communities/coverage?city_code= —— 城市内逐小区覆盖（首页最近更新小区） */
export function getCommunitiesCoverage(cityCode: string): Promise<{
  city_code: string;
  items: CommunityCoverageItem[];
  count: number;
}> {
  return request(
    `/public/communities/coverage?city_code=${encodeURIComponent(cityCode)}`,
  );
}

export interface MethodologyFieldVerification {
  field_code: string;
  field_label: string;
  metric_code: string | null;
  status: string;
  evidence: string | null;
  verified_at: string | null;
}

export interface MethodologySource {
  source_id: string;
  name: string;
  source_type: string;
  official_url: string | null;
  data_scope: string | null;
  license_note_url: string | null;
  display_scope: string | null;
  updated_at: string;
  last_verified_at: string | null;
  license_status: string;
  license_valid_until: string | null;
  field_verifications: MethodologyFieldVerification[];
  verified_metrics: string[];
}

/** GET /public/methodology/sources —— 可公开的数据源说明（口径/许可/验证状态） */
export function getMethodologySources(): Promise<{
  items: MethodologySource[];
  count: number;
}> {
  return request("/public/methodology/sources");
}

export interface SystemStatus {
  status: string;
  cities_catalog_active?: number;
  cities_data_active?: number;
  sources_total?: number;
  last_collected_at?: string | null;
  observations_total?: number;
  checked_at: string;
}

/** GET /public/system/status —— 数据更新时间与覆盖规模 */
export function getSystemStatus(): Promise<SystemStatus> {
  return request("/public/system/status");
}

/** POST /me/city-coverage-requests——覆盖申请（登录；同人同城处理中重复 → 409 already_requested） */
export function createCityCoverageRequest(input: {
  city_code?: string;
  requested_city_name: string;
  requested_province_name?: string;
  reason?: string;
}): Promise<{
  request: {
    request_id: string;
    city_code: string | null;
    requested_city_name: string;
    status: string;
  };
}> {
  return request("/me/city-coverage-requests", {
    method: "POST",
    body: JSON.stringify(input),
    skipAuthRedirect: true,
  });
}

/** GET /public/communities?region_id=&q=&limit= —— 小区搜索（联想/列表） */
export function getPublicCommunities(params: {
  region_id?: string;
  q?: string;
  limit?: number;
}): Promise<{ items: CommunityItem[]; count: number }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const qs = query.toString();
  return request(`/public/communities${qs ? `?${qs}` : ""}`);
}

// ---------------- TASK-10：用户管理与审计日志前端（PRD §8.3 / §8.1 第 9 项） ----------------

/** GET /admin/users item：脱敏用户行（零明文邮箱；watch_count=活跃监控数） */
export interface AdminUserItem {
  user_id: string;
  email_masked: string;
  /** active / frozen / deletion_pending（注销冷静期，无管理员处理端点） */
  status: string;
  email_verified: boolean;
  created_at: string;
  last_login_at: string | null;
  is_admin: boolean;
  watch_count: number;
}

export interface UserListResponse {
  items: AdminUserItem[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /admin/audit item：审计日志行（append-only） */
export interface AuditItem {
  audit_id: string;
  actor_user_id: string;
  actor_role: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  reason: string | null;
  created_at: string;
}

export interface AuditListResponse {
  items: AuditItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 监控明细抽屉的规则行（is_enabled 为 0/1 数值，与后端存储一致） */
export interface MonitoringRuleDetail {
  rule_id: string;
  rule_type: string;
  metric_code: string;
  price_type: string | null;
  target_value: number | null;
  currency: string;
  unit: string | null;
  window_days: number | null;
  threshold_pct: number | null;
  is_enabled: number;
  armed_state: string;
}

/** GET /admin/users/:id/monitoring 响应（服务端强制写审计 admin.user.monitoring_view） */
export interface UserMonitoringResponse {
  user: {
    user_id: string;
    email_masked: string;
    status: string;
    created_at: string;
    last_login_at: string | null;
  };
  watches: Array<{
    watch_id: string;
    object_type: string;
    object_id: string;
    display_name_snapshot: string;
    priority: number;
    status: string;
    created_at: string;
    rules: MonitoringRuleDetail[];
  }>;
  counts: { watches: number; rules: number };
}

/** GET /admin/users：用户列表（q 仅精确匹配 user_id 或完整邮箱；status 仅 active/frozen） */
export function adminUsersList(
  query: { q?: string; status?: string; limit?: number; offset?: number } = {},
): Promise<UserListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/admin/users${qs ? `?${qs}` : ""}`);
}

/** PATCH /admin/users/:id/status：冻结/解冻（reason 8–500；409=冻结自己或状态相同） */
export function adminUserPatchStatus(
  id: string,
  input: { status: "active" | "frozen"; reason: string },
): Promise<{ user: AdminUserItem }> {
  return request(`/admin/users/${encodeURIComponent(id)}/status`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

/** GET /admin/users/:id/monitoring：个人监控明细（reason 10–500 必填，查看行为写审计） */
export function adminUserMonitoring(
  id: string,
  reason: string,
): Promise<UserMonitoringResponse> {
  const query = new URLSearchParams({ reason });
  return request(
    `/admin/users/${encodeURIComponent(id)}/monitoring?${query.toString()}`,
  );
}

/** GET /admin/audit：审计日志分页查询（limit≤200 默认 50；三个筛选均精确匹配） */
export function adminAuditList(
  query: {
    limit?: number;
    offset?: number;
    action?: string;
    actor_user_id?: string;
    resource_type?: string;
  } = {},
): Promise<AuditListResponse> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return request(`/admin/audit${qs ? `?${qs}` : ""}`);
}
