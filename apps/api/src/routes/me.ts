// TASK-02B：用户 API（PRD §10.3 /me/*）——强制登录，所有读写按 user_id 隔离。
// 跨用户访问一律返回 404（不泄露他人资源是否存在，PRD §12.0-5/验收）。
import { Hono, type Context } from "hono";
import { deleteCookie } from "hono/cookie";
import {
  validateRuleBinding,
  type RuleBindingInput,
  type RuleObjectType,
} from "@property-radar/shared";
import { requireSession } from "../auth";
import { DELETION_COOLDOWN_DAYS } from "../deletion";
import { errors } from "../errors";
import { SESSION_COOKIE, type AppEnv } from "../env";
import { EVENT_TYPES, type EventType } from "../events";
import { readJsonBody, validateOrThrow } from "../validation";
import {
  createPushSubscriptionSchema,
  createRuleSchema,
  createWatchItemSchema,
  deleteAccountSchema,
  deletePushSubscriptionSchema,
  eventReadSchema,
  patchPreferencesSchema,
  patchRuleSchema,
  patchWatchItemSchema,
} from "../schemas";

export const meRoutes = new Hono<AppEnv>();

// 所有 /me/* 端点先过会话校验
meRoutes.use("*", requireSession);

/** D1/SQLite 唯一约束 → 稳定 409（不向客户端暴露 SQL/表结构） */
function mapDbError(e: unknown): never {
  if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
    throw errors.conflict();
  }
  throw e;
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  return readJsonBody(c.req.header("content-type"), () => c.req.text());
}

// ---------------- 监控对象 ----------------

interface WatchRow {
  watch_id: string;
  user_id: string;
  object_type: string;
  object_id: string;
  display_name_snapshot: string;
  priority: number;
  status: string;
  created_at: string;
  updated_at: string;
}

const WATCH_COLUMNS = `watch_id, object_type, object_id, display_name_snapshot,
  priority, status, created_at, updated_at`;

/** item 响应行：LEFT JOIN 分组表得到 group_name（未分组为 null） */
type WatchItemRow = Omit<WatchRow, "user_id"> & { group_name: string | null };

/** 规则摘要高亮行（03B 卡片“目标值/规则状态”渲染用） */
interface RuleHighlight {
  rule_id: string;
  rule_type: string;
  metric_code: string;
  price_type: string | null;
  target_value: number | null;
  unit: string | null;
  threshold_pct: number | null;
}

/** item 最终响应：读取时计算的 auto_monitoring + 规则摘要 */
type WatchItem = WatchItemRow & {
  auto_monitoring: boolean;
  enabled_rule_count: number;
  rule_highlight: RuleHighlight | null;
};

/** 带分组名的查询（LEFT JOIN watch_item_groups，联接条件同时限定 user_id） */
const ITEM_SELECT = `SELECT w.watch_id, w.object_type, w.object_id,
    w.display_name_snapshot, w.priority, w.status, w.created_at, w.updated_at,
    g.group_name
  FROM watch_items w
  LEFT JOIN watch_item_groups g
    ON g.watch_id = w.watch_id AND g.user_id = w.user_id`;

async function loadOwnWatch(
  c: Context<AppEnv>,
  userId: string,
  watchId: string,
): Promise<WatchRow> {
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT ${WATCH_COLUMNS} FROM watch_items WHERE watch_id = ? AND user_id = ?`,
  )
    .bind(watchId, userId)
    .first<WatchRow>();
  if (!row) throw errors.notFound("监控对象不存在");
  return row;
}

/** 加载本人单个监控对象（含 group_name），不存在（含他人资源）→ 404 */
async function loadOwnWatchItem(
  c: Context<AppEnv>,
  userId: string,
  watchId: string,
): Promise<WatchItemRow> {
  const row = await c.env.DB_PRIVATE.prepare(
    `${ITEM_SELECT} WHERE w.watch_id = ? AND w.user_id = ?`,
  )
    .bind(watchId, userId)
    .first<WatchItemRow>();
  if (!row) throw errors.notFound("监控对象不存在");
  return row;
}

/**
 * 读取时批量计算 auto_monitoring（不落库）：按 object_type 分组后每类型至多
 * 1 条 IN 查询（region/community 查 Public 的 price_snapshots，listing 查
 * listing_price_events_public），总计 ≤3 条，禁止逐条 N+1。
 */
async function attachAutoMonitoring<
  T extends { object_type: string; object_id: string },
>(
  c: Context<AppEnv>,
  items: T[],
): Promise<Array<T & { auto_monitoring: boolean }>> {
  // 收集各类型去重后的 object_id
  const idsByType = new Map<string, Set<string>>();
  for (const item of items) {
    const set = idsByType.get(item.object_type) ?? new Set<string>();
    set.add(item.object_id);
    idsByType.set(item.object_type, set);
  }
  const covered = new Set<string>(); // `${object_type}:${object_id}` 有价格数据
  for (const [objectType, idSet] of idsByType) {
    const ids = [...idSet];
    const marks = ids.map(() => "?").join(", ");
    if (objectType === "listing") {
      // listing 的目录键即 listing_key_hash（Public 库唯一索引键）
      const res = await c.env.DB_PUBLIC.prepare(
        `SELECT DISTINCT listing_key_hash FROM listing_price_events_public
         WHERE listing_key_hash IN (${marks})`,
      )
        .bind(...ids)
        .all<{ listing_key_hash: string }>();
      for (const row of res.results) {
        covered.add(`listing:${row.listing_key_hash}`);
      }
    } else {
      const res = await c.env.DB_PUBLIC.prepare(
        `SELECT DISTINCT object_id FROM price_snapshots
         WHERE object_type = ? AND object_id IN (${marks})`,
      )
        .bind(objectType, ...ids)
        .all<{ object_id: string }>();
      for (const row of res.results) {
        covered.add(`${objectType}:${row.object_id}`);
      }
    }
  }
  return items.map((item) => ({
    ...item,
    auto_monitoring: covered.has(`${item.object_type}:${item.object_id}`),
  }));
}

/**
 * 批量附加规则摘要（03B）：1 条聚合 SQL 查出全部已启用规则（按 created_at
 * 倒序），JS 分组得到每对象的 enabled_rule_count 与最新规则高亮，禁止 N+1。
 */
async function attachRuleSummary<T extends { watch_id: string }>(
  c: Context<AppEnv>,
  userId: string,
  items: T[],
): Promise<
  Array<
    T & { enabled_rule_count: number; rule_highlight: RuleHighlight | null }
  >
> {
  if (items.length === 0) return [];
  const marks = items.map(() => "?").join(", ");
  const res = await c.env.DB_PRIVATE.prepare(
    `SELECT rule_id, watch_id, rule_type, metric_code, price_type,
       target_value, unit, threshold_pct
     FROM watch_rules
     WHERE user_id = ? AND is_enabled = 1 AND watch_id IN (${marks})
     ORDER BY created_at DESC, rule_id DESC`,
  )
    .bind(userId, ...items.map((i) => i.watch_id))
    .all<RuleHighlight & { watch_id: string }>();
  const byWatch = new Map<
    string,
    { count: number; highlight: RuleHighlight | null }
  >();
  for (const row of res.results) {
    let entry = byWatch.get(row.watch_id);
    if (!entry) {
      entry = { count: 0, highlight: null };
      byWatch.set(row.watch_id, entry);
    }
    entry.count += 1;
    // 倒序第一条即最新规则（ORDER BY created_at DESC）
    if (!entry.highlight) {
      entry.highlight = {
        rule_id: row.rule_id,
        rule_type: row.rule_type,
        metric_code: row.metric_code,
        price_type: row.price_type,
        target_value: row.target_value,
        unit: row.unit,
        threshold_pct: row.threshold_pct,
      };
    }
  }
  return items.map((item) => {
    const entry = byWatch.get(item.watch_id);
    return {
      ...item,
      enabled_rule_count: entry?.count ?? 0,
      rule_highlight: entry?.highlight ?? null,
    };
  });
}

/** 单个 item 响应：读取本人对象（含 group_name）+ auto_monitoring + 规则摘要 */
async function loadRespondItem(
  c: Context<AppEnv>,
  userId: string,
  watchId: string,
): Promise<WatchItem> {
  const row = await loadOwnWatchItem(c, userId, watchId);
  const withAuto = (await attachAutoMonitoring(c, [row]))[0]!;
  const item = (await attachRuleSummary(c, userId, [withAuto]))[0]!;
  return item;
}

// GET /me/watch-items?status=&object_type=&group_name=&sort=&order=
meRoutes.get("/watch-items", async (c) => {
  // 空串按未提供处理（与 limit 参数风格一致）；非法值 → 400 validation_failed
  const pick = (name: string): string | undefined => {
    const v = c.req.query(name);
    return v === undefined || v === "" ? undefined : v;
  };
  const status = pick("status");
  const objectType = pick("object_type");
  const groupName = pick("group_name");
  const sort = pick("sort") ?? "created_at";
  const order = pick("order") ?? "desc";
  const invalid: Array<{ field: string; message: string }> = [];
  if (
    status !== undefined &&
    !["active", "paused", "archived", "all"].includes(status)
  ) {
    invalid.push({
      field: "status",
      message: "必须是 active、paused、archived 或 all",
    });
  }
  if (
    objectType !== undefined &&
    !["region", "community", "listing"].includes(objectType)
  ) {
    invalid.push({
      field: "object_type",
      message: "必须是 region、community 或 listing",
    });
  }
  if (
    groupName !== undefined &&
    (groupName.length < 1 || groupName.length > 50)
  ) {
    invalid.push({ field: "group_name", message: "长度必须是 1-50 字符" });
  }
  if (!["created_at", "priority"].includes(sort)) {
    invalid.push({ field: "sort", message: "必须是 created_at 或 priority" });
  }
  if (!["asc", "desc"].includes(order)) {
    invalid.push({ field: "order", message: "必须是 asc 或 desc" });
  }
  if (invalid.length > 0) throw errors.validation(invalid);

  const where = ["w.user_id = ?"]; // 强制 user_id 过滤（数据隔离）
  const params: Array<string | number> = [c.get("userId")];
  if (status !== undefined && status !== "all") {
    where.push("w.status = ?");
    params.push(status);
  }
  if (objectType !== undefined) {
    where.push("w.object_type = ?");
    params.push(objectType);
  }
  if (groupName !== undefined) {
    where.push("g.group_name = ?");
    params.push(groupName);
  }
  const res = await c.env.DB_PRIVATE.prepare(
    `${ITEM_SELECT}
     WHERE ${where.join(" AND ")}
     ORDER BY w.${sort} ${order}
     LIMIT 50`,
  )
    .bind(...params)
    .all<WatchItemRow>();
  const withAuto = await attachAutoMonitoring(c, res.results);
  const items = await attachRuleSummary(c, c.get("userId"), withAuto);
  return c.json({ items, count: items.length });
});

// POST /me/watch-items
meRoutes.post("/watch-items", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(createWatchItemSchema, body);
  const input = body as {
    object_type: string;
    object_id: string;
    display_name_snapshot: string;
    priority?: number;
    group_name?: string;
  };
  const userId = c.get("userId");
  // 目录存在性校验：region/community 必须在 Public 目录中（不存在→404）；
  // listing 不做目录校验（数据来源支持后放开），未覆盖价格数据只影响 auto_monitoring。
  if (input.object_type === "region") {
    const hit = await c.env.DB_PUBLIC.prepare(
      "SELECT region_id FROM regions WHERE region_id = ?",
    )
      .bind(input.object_id)
      .first();
    if (!hit) throw errors.notFound("区域不存在或未收录");
  } else if (input.object_type === "community") {
    const hit = await c.env.DB_PUBLIC.prepare(
      "SELECT community_id FROM communities WHERE community_id = ?",
    )
      .bind(input.object_id)
      .first();
    if (!hit) throw errors.notFound("小区不存在或未收录");
  }
  const watchId = crypto.randomUUID();
  try {
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO watch_items
         (watch_id, user_id, object_type, object_id, display_name_snapshot, priority, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))`,
    )
      .bind(
        watchId,
        userId,
        input.object_type,
        input.object_id,
        input.display_name_snapshot,
        input.priority ?? 0,
      )
      .run();
    // 可选分组：创建时即入组（重复对象在上面 INSERT 时 UNIQUE→409）
    if (input.group_name !== undefined) {
      await c.env.DB_PRIVATE.prepare(
        `INSERT INTO watch_item_groups (watch_id, user_id, group_name, updated_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
        .bind(watchId, userId, input.group_name)
        .run();
    }
  } catch (e) {
    mapDbError(e);
  }
  const item = await loadRespondItem(c, userId, watchId);
  return c.json({ item }, 201);
});

// PATCH /me/watch-items/:id
meRoutes.patch("/watch-items/:id", async (c) => {
  const userId = c.get("userId");
  const watchId = c.req.param("id");
  const body = await jsonBody(c);
  validateOrThrow(patchWatchItemSchema, body);
  const patch = body as Partial<{
    display_name_snapshot: string;
    priority: number;
    status: string;
    group_name: string | null;
  }>;
  await loadOwnWatch(c, userId, watchId); // 不存在（含他人资源）→ 404
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: Array<string | number> = [];
  if (patch.display_name_snapshot !== undefined) {
    sets.push("display_name_snapshot = ?");
    params.push(patch.display_name_snapshot);
  }
  if (patch.priority !== undefined) {
    sets.push("priority = ?");
    params.push(patch.priority);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    params.push(patch.status);
  }
  params.push(watchId, userId);
  try {
    await c.env.DB_PRIVATE.prepare(
      `UPDATE watch_items SET ${sets.join(", ")} WHERE watch_id = ? AND user_id = ?`,
    )
      .bind(...params)
      .run();
    // 分组：字符串 = 入组/改组（upsert），null = 移出分组（删本人该对象的分组行）
    if (patch.group_name !== undefined) {
      if (patch.group_name === null) {
        await c.env.DB_PRIVATE.prepare(
          "DELETE FROM watch_item_groups WHERE watch_id = ? AND user_id = ?",
        )
          .bind(watchId, userId)
          .run();
      } else {
        await c.env.DB_PRIVATE.prepare(
          `INSERT INTO watch_item_groups (watch_id, user_id, group_name, updated_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(watch_id) DO UPDATE SET
             group_name = excluded.group_name,
             updated_at = datetime('now')`,
        )
          .bind(watchId, userId, patch.group_name)
          .run();
      }
    }
  } catch (e) {
    mapDbError(e);
  }
  return c.json({ item: await loadRespondItem(c, userId, watchId) });
});

// DELETE /me/watch-items/:id
meRoutes.delete("/watch-items/:id", async (c) => {
  const userId = c.get("userId");
  const watchId = c.req.param("id");
  await loadOwnWatch(c, userId, watchId);
  await c.env.DB_PRIVATE.prepare(
    "DELETE FROM watch_items WHERE watch_id = ? AND user_id = ?",
  )
    .bind(watchId, userId)
    .run();
  return c.json({ deleted: true });
});

// ---------------- 监控规则（TASK-03B：绑定校验 / 有效期 / 每规则渠道 / 版本与 re-arm） ----------------

interface RuleRow {
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
}

const RULE_COLUMNS = `rule_id, watch_id, rule_type, metric_code, price_type,
  target_value, currency, unit, window_days, threshold_pct, hysteresis_pct,
  is_enabled, armed_state, version, created_at, updated_at`;

/** 侧表列（LEFT JOIN 后缺行为 null，合并时按默认渠道全开处理） */
interface RuleSettingsCols {
  valid_until: string | null;
  notify_email: number | null;
  notify_digest: number | null;
  notify_inapp: number | null;
}

/** 规则响应 item：规则行 + 有效期/渠道 + 读取时计算的 is_expired */
type RuleItem = RuleRow & {
  valid_until: string | null;
  notify_email: boolean;
  notify_digest: boolean;
  notify_inapp: boolean;
  is_expired: boolean;
};

/** 规则行 + 父对象 object_type + 侧表列（绑定校验与合并态 PATCH 用） */
type RuleContext = RuleRow &
  Partial<RuleSettingsCols> & { object_type: string };

/** 带父对象与侧表的统一查询（GET 列表 / 单条响应 / PATCH 上下文共用） */
const RULE_SELECT_CTX = `SELECT ${RULE_COLUMNS.split(/,\s*/)
  .map((col) => `r.${col}`)
  .join(", ")}, w.object_type,
    s.valid_until, s.notify_email, s.notify_digest, s.notify_inapp
  FROM watch_rules r
  JOIN watch_items w ON w.watch_id = r.watch_id
  LEFT JOIN watch_rule_settings s ON s.rule_id = r.rule_id`;

/** 内容字段（PATCH 出现 → 重跑绑定校验；值有变化 → version+1） */
const RULE_CONTENT_FIELDS = [
  "rule_type",
  "metric_code",
  "price_type",
  "target_value",
  "currency",
  "unit",
  "window_days",
  "threshold_pct",
  "hysteresis_pct",
] as const;

/** 设置字段（写侧表，不递增 version） */
const RULE_SETTING_FIELDS = [
  "valid_until",
  "notify_email",
  "notify_digest",
  "notify_inapp",
] as const;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 侧表行合并为响应 item：缺行 → 渠道默认全开、有效期 null；计算 is_expired */
function toRuleItem(row: RuleRow & Partial<RuleSettingsCols>): RuleItem {
  const validUntil = row.valid_until ?? null;
  const flag = (v: number | null | undefined): boolean =>
    v == null ? true : v === 1;
  return {
    ...row,
    valid_until: validUntil,
    notify_email: flag(row.notify_email),
    notify_digest: flag(row.notify_digest),
    notify_inapp: flag(row.notify_inapp),
    is_expired: validUntil !== null && validUntil < todayStr(),
  };
}

/** 语义绑定校验失败 → 400 errors.validation（文案来自 shared 矩阵，前后端一致） */
function assertRuleBinding(input: RuleBindingInput, objectType: string): void {
  const problems = validateRuleBinding(input, objectType as RuleObjectType);
  if (problems.length > 0) {
    throw errors.validation(
      problems.map((message) => ({ field: "/", message })),
    );
  }
}

/** 通知渠道至少保留一个（PRD 演示 UI 同规则） */
function assertNotifyChannels(
  email: boolean,
  digest: boolean,
  inapp: boolean,
): void {
  if (!email && !digest && !inapp) {
    throw errors.validation([
      {
        field: "/",
        message: "至少保留一个通知渠道（触发邮件 / 每日摘要 / 站内事件）",
      },
    ]);
  }
}

/** 读取本人规则（含侧表与父对象），不存在（含他人资源）→ 404 */
async function loadRuleContext(
  c: Context<AppEnv>,
  userId: string,
  ruleId: string,
): Promise<RuleContext> {
  const row = await c.env.DB_PRIVATE.prepare(
    `${RULE_SELECT_CTX} WHERE r.rule_id = ? AND r.user_id = ?`,
  )
    .bind(ruleId, userId)
    .first<RuleContext>();
  if (!row) throw errors.notFound("规则不存在");
  return row;
}

// GET /me/watch-items/:id/rules
meRoutes.get("/watch-items/:id/rules", async (c) => {
  const userId = c.get("userId");
  await loadOwnWatch(c, userId, c.req.param("id"));
  const res = await c.env.DB_PRIVATE.prepare(
    `${RULE_SELECT_CTX}
     WHERE r.watch_id = ? AND r.user_id = ?
     ORDER BY r.created_at DESC LIMIT 50`,
  )
    .bind(c.req.param("id"), userId)
    .all<RuleContext>();
  const items = res.results.map(toRuleItem);
  return c.json({ items, count: items.length });
});

// POST /me/watch-items/:id/rules
meRoutes.post("/watch-items/:id/rules", async (c) => {
  const userId = c.get("userId");
  const watchId = c.req.param("id");
  const watch = await loadOwnWatch(c, userId, watchId);
  const body = await jsonBody(c);
  validateOrThrow(createRuleSchema, body);
  const input = body as {
    rule_type: string;
    metric_code: string;
    price_type?: string;
    target_value?: number | null;
    currency?: string;
    unit?: string | null;
    window_days?: number | null;
    threshold_pct?: number | null;
    hysteresis_pct?: number | null;
    is_enabled?: boolean;
    valid_until?: string | null;
    notify_email?: boolean;
    notify_digest?: boolean;
    notify_inapp?: boolean;
  };
  // 绑定交叉校验：rule_type × 父对象 object_type × metric/price_type/unit × 字段策略
  assertRuleBinding(input, watch.object_type);
  const channels = {
    email: input.notify_email ?? true,
    digest: input.notify_digest ?? true,
    inapp: input.notify_inapp ?? true,
  };
  assertNotifyChannels(channels.email, channels.digest, channels.inapp);
  const ruleId = crypto.randomUUID();
  try {
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO watch_rules
         (rule_id, watch_id, user_id, rule_type, metric_code, price_type,
          target_value, currency, unit, window_days, threshold_pct, hysteresis_pct,
          is_enabled, armed_state, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'armed', 1, datetime('now'))`,
    )
      .bind(
        ruleId,
        watchId,
        userId,
        input.rule_type,
        input.metric_code,
        input.price_type ?? null,
        input.target_value ?? null,
        input.currency ?? "CNY",
        input.unit ?? null,
        input.window_days ?? null,
        input.threshold_pct ?? null,
        input.hysteresis_pct ?? null,
        input.is_enabled === false ? 0 : 1,
      )
      .run();
    // 03B：每规则设置行（有效期 + 渠道），删除规则/对象时随 FK 级联清理
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO watch_rule_settings
         (rule_id, user_id, valid_until, notify_email, notify_digest, notify_inapp, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
      .bind(
        ruleId,
        userId,
        input.valid_until ?? null,
        channels.email ? 1 : 0,
        channels.digest ? 1 : 0,
        channels.inapp ? 1 : 0,
      )
      .run();
  } catch (e) {
    mapDbError(e);
  }
  const item = await loadRuleContext(c, userId, ruleId);
  return c.json({ item: toRuleItem(item) }, 201);
});

// PATCH /me/rules/:id
meRoutes.patch("/rules/:id", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("id");
  const body = await jsonBody(c);
  validateOrThrow(patchRuleSchema, body);
  const patch = body as Partial<{
    rule_type: string;
    metric_code: string;
    price_type: string;
    target_value: number | null;
    currency: string;
    unit: string | null;
    window_days: number | null;
    threshold_pct: number | null;
    hysteresis_pct: number | null;
    is_enabled: boolean;
    valid_until: string | null;
    notify_email: boolean;
    notify_digest: boolean;
    notify_inapp: boolean;
  }>;
  const stored = await loadRuleContext(c, userId, ruleId);

  // 1) 内容字段出现 → 按合并态（存储 + patch）重跑绑定校验，先于任何写入
  let contentChanged = false;
  for (const key of RULE_CONTENT_FIELDS) {
    if (key in patch && patch[key] !== stored[key]) contentChanged = true;
  }
  if (RULE_CONTENT_FIELDS.some((key) => key in patch)) {
    const merged: RuleBindingInput = {
      rule_type: "rule_type" in patch ? patch.rule_type : stored.rule_type,
      metric_code:
        "metric_code" in patch ? patch.metric_code : stored.metric_code,
      price_type: "price_type" in patch ? patch.price_type : stored.price_type,
      unit: "unit" in patch ? patch.unit : stored.unit,
      target_value:
        "target_value" in patch ? patch.target_value : stored.target_value,
      threshold_pct:
        "threshold_pct" in patch ? patch.threshold_pct : stored.threshold_pct,
      window_days:
        "window_days" in patch ? patch.window_days : stored.window_days,
    };
    assertRuleBinding(merged, stored.object_type);
  }

  // 2) 渠道合并后至少保留一个（仅在本次触及渠道字段时校验）
  const channelsTouched = RULE_SETTING_FIELDS.slice(1).some(
    (key) => key in patch,
  );
  const channel = {
    email:
      patch.notify_email ??
      (stored.notify_email == null ? true : stored.notify_email === 1),
    digest:
      patch.notify_digest ??
      (stored.notify_digest == null ? true : stored.notify_digest === 1),
    inapp:
      patch.notify_inapp ??
      (stored.notify_inapp == null ? true : stored.notify_inapp === 1),
  };
  if (channelsTouched) {
    assertNotifyChannels(channel.email, channel.digest, channel.inapp);
  }

  // 3) 有效期/渠道 → 侧表 upsert（不递增 version）
  if (RULE_SETTING_FIELDS.some((key) => key in patch)) {
    const validUntil =
      "valid_until" in patch
        ? (patch.valid_until ?? null)
        : (stored.valid_until ?? null);
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO watch_rule_settings
         (rule_id, user_id, valid_until, notify_email, notify_digest, notify_inapp, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(rule_id) DO UPDATE SET
         valid_until = excluded.valid_until,
         notify_email = excluded.notify_email,
         notify_digest = excluded.notify_digest,
         notify_inapp = excluded.notify_inapp,
         updated_at = datetime('now')`,
    )
      .bind(
        ruleId,
        userId,
        validUntil,
        channel.email ? 1 : 0,
        channel.digest ? 1 : 0,
        channel.inapp ? 1 : 0,
      )
      .run();
  }

  // 4) 规则行更新：内容字段 → version+1；启用（0→1）→ armed_state 重新布防
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: Array<string | number | null> = [];
  for (const key of RULE_CONTENT_FIELDS) {
    if (key in patch) {
      sets.push(`${key} = ?`);
      params.push(patch[key] as string | number | null);
    }
  }
  if ("is_enabled" in patch) {
    sets.push("is_enabled = ?");
    params.push(patch.is_enabled ? 1 : 0);
    if (patch.is_enabled === true && stored.is_enabled === 0) {
      sets.push("armed_state = 'armed'"); // 启用即重新布防（状态机本体属 03C）
    }
  }
  if (contentChanged) {
    sets.push("version = version + 1");
  }
  params.push(ruleId, userId);
  await c.env.DB_PRIVATE.prepare(
    `UPDATE watch_rules SET ${sets.join(", ")} WHERE rule_id = ? AND user_id = ?`,
  )
    .bind(...params)
    .run();
  const item = await loadRuleContext(c, userId, ruleId);
  return c.json({ item: toRuleItem(item) });
});

// DELETE /me/rules/:id（watch_rule_settings 随 FK 级联删除）
meRoutes.delete("/rules/:id", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("id");
  await loadRuleContext(c, userId, ruleId);
  await c.env.DB_PRIVATE.prepare(
    "DELETE FROM watch_rules WHERE rule_id = ? AND user_id = ?",
  )
    .bind(ruleId, userId)
    .run();
  return c.json({ deleted: true });
});

// ---------------- 事件 ----------------

// GET /me/events?unread=&limit=&type=
meRoutes.get("/events", async (c) => {
  const unread = c.req.query("unread");
  if (unread !== undefined && unread !== "true" && unread !== "false") {
    throw errors.validation([
      { field: "unread", message: "必须是 true 或 false" },
    ]);
  }
  const limitRaw = c.req.query("limit");
  let limit = 20;
  if (limitRaw !== undefined && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw errors.validation([
        { field: "limit", message: "必须是 1-50 的整数" },
      ]);
    }
    limit = n;
  }
  const typeRaw = c.req.query("type");
  if (
    typeRaw !== undefined &&
    typeRaw !== "" &&
    !EVENT_TYPES.includes(typeRaw as EventType)
  ) {
    throw errors.validation([
      {
        field: "type",
        message: `必须是事件类型枚举之一（${EVENT_TYPES.join("/")}）`,
      },
    ]);
  }
  const where = ["user_id = ?"];
  const params: Array<string | number> = [c.get("userId")];
  if (unread === "true") where.push("read_at IS NULL");
  if (typeRaw !== undefined && typeRaw !== "") {
    where.push("event_type = ?");
    params.push(typeRaw);
  }
  params.push(limit);
  const res = await c.env.DB_PRIVATE.prepare(
    `SELECT event_id, rule_id, watch_id, snapshot_id, event_type, old_value, new_value,
            target_value, difference_pct, evidence_json, status, created_at, read_at
     FROM alert_events
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all();
  // 未读总数（当前用户，不受 limit/type 过滤影响——供导航角标）
  const unreadRow = await c.env.DB_PRIVATE.prepare(
    "SELECT COUNT(*) AS n FROM alert_events WHERE user_id = ? AND read_at IS NULL",
  )
    .bind(c.get("userId"))
    .first<{ n: number }>();
  const items = (res.results as Array<Record<string, unknown>>).map((row) => {
    const { evidence_json: evidenceJson, ...rest } = row;
    let evidence: unknown = {};
    if (typeof evidenceJson === "string") {
      try {
        evidence = JSON.parse(evidenceJson);
      } catch {
        evidence = {}; // 证据损坏不阻塞展示（PRD 2.2A 降级）
      }
    }
    return { ...rest, evidence };
  });
  return c.json({
    items,
    count: items.length,
    unread_count: unreadRow?.n ?? 0,
  });
});

// PATCH /me/events/:id/read —— 标记已读/未读（幂等；{read:false}=标记未读）
meRoutes.patch("/events/:id/read", async (c) => {
  const userId = c.get("userId");
  const eventId = c.req.param("id");
  const body = await jsonBody(c);
  validateOrThrow(eventReadSchema, body);
  const markRead = (body as { read?: boolean }).read !== false;
  const row = await c.env.DB_PRIVATE.prepare(
    "SELECT event_id FROM alert_events WHERE event_id = ? AND user_id = ?",
  )
    .bind(eventId, userId)
    .first();
  if (!row) throw errors.notFound("事件不存在");
  if (markRead) {
    await c.env.DB_PRIVATE.prepare(
      `UPDATE alert_events
       SET read_at = COALESCE(read_at, datetime('now')), status = 'read'
       WHERE event_id = ? AND user_id = ?`,
    )
      .bind(eventId, userId)
      .run();
  } else {
    await c.env.DB_PRIVATE.prepare(
      `UPDATE alert_events
       SET read_at = NULL, status = 'unread'
       WHERE event_id = ? AND user_id = ?`,
    )
      .bind(eventId, userId)
      .run();
  }
  const updated = await c.env.DB_PRIVATE.prepare(
    `SELECT event_id, status, read_at FROM alert_events
     WHERE event_id = ? AND user_id = ?`,
  )
    .bind(eventId, userId)
    .first();
  return c.json({ event: updated });
});

// ---------------- 通知设置 ----------------

interface PrefRow {
  email_enabled: number;
  digest_enabled: number;
  digest_time: string | null;
  browser_push_enabled: number;
  timezone: string;
  updated_at?: string;
}

const PREF_DEFAULTS: PrefRow = {
  email_enabled: 1,
  digest_enabled: 0,
  digest_time: "07:30",
  browser_push_enabled: 0,
  timezone: "Asia/Shanghai",
};

/** DB 0/1 → API 布尔（digest_time 允许 NULL 时回退默认值） */
function prefToJson(row: PrefRow): {
  email_enabled: boolean;
  digest_enabled: boolean;
  digest_time: string;
  browser_push_enabled: boolean;
  timezone: string;
} {
  return {
    email_enabled: row.email_enabled === 1,
    digest_enabled: row.digest_enabled === 1,
    digest_time: row.digest_time ?? PREF_DEFAULTS.digest_time ?? "07:30",
    browser_push_enabled: row.browser_push_enabled === 1,
    timezone: row.timezone,
  };
}

// GET /me/notification-preferences（无记录时返回默认值，不落库）
meRoutes.get("/notification-preferences", async (c) => {
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT email_enabled, digest_enabled, digest_time, browser_push_enabled, timezone
     FROM notification_preferences WHERE user_id = ?`,
  )
    .bind(c.get("userId"))
    .first<PrefRow>();
  return c.json({
    preferences: prefToJson({ ...PREF_DEFAULTS, ...(row ?? {}) }),
  });
});

// PATCH /me/notification-preferences —— UPSERT
meRoutes.patch("/notification-preferences", async (c) => {
  const userId = c.get("userId");
  const body = await jsonBody(c);
  validateOrThrow(patchPreferencesSchema, body);
  const patch = body as Partial<{
    email_enabled: boolean;
    digest_enabled: boolean;
    digest_time: string;
    browser_push_enabled: boolean;
    timezone: string;
  }>;
  const current = await c.env.DB_PRIVATE.prepare(
    `SELECT email_enabled, digest_enabled, digest_time, browser_push_enabled, timezone
     FROM notification_preferences WHERE user_id = ?`,
  )
    .bind(userId)
    .first<PrefRow>();
  const merged = { ...PREF_DEFAULTS, ...(current ?? {}) };
  const next: PrefRow = {
    email_enabled:
      patch.email_enabled === undefined
        ? merged.email_enabled
        : patch.email_enabled
          ? 1
          : 0,
    digest_enabled:
      patch.digest_enabled === undefined
        ? merged.digest_enabled
        : patch.digest_enabled
          ? 1
          : 0,
    digest_time: patch.digest_time ?? merged.digest_time ?? "07:30",
    browser_push_enabled:
      patch.browser_push_enabled === undefined
        ? merged.browser_push_enabled
        : patch.browser_push_enabled
          ? 1
          : 0,
    timezone: patch.timezone ?? merged.timezone,
  };
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO notification_preferences
       (user_id, email_enabled, digest_enabled, digest_time, browser_push_enabled, timezone, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       email_enabled = excluded.email_enabled,
       digest_enabled = excluded.digest_enabled,
       digest_time = excluded.digest_time,
       browser_push_enabled = excluded.browser_push_enabled,
       timezone = excluded.timezone,
       updated_at = datetime('now')`,
  )
    .bind(
      userId,
      next.email_enabled,
      next.digest_enabled,
      next.digest_time,
      next.browser_push_enabled,
      next.timezone,
    )
    .run();
  return c.json({ preferences: prefToJson(next) });
});

// ---------------- 浏览器推送订阅（TASK-05C / spec §3.2） ----------------

// POST /me/push-subscriptions —— upsert（同 endpoint 重复订阅 = 更新密钥并复活）
meRoutes.post("/push-subscriptions", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(createPushSubscriptionSchema, body);
  const input = body as {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  // TASK-07A（SSRF 修复，PRD §7.6）：endpoint 会被服务端 fetch 投递，
  // 强制 https 并拒绝 IP 字面量 / 回环 / 链路本地（元数据）/ 私网段 / 内网名形态。
  try {
    const url = new URL(input.endpoint);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    const isIpv6 = host.includes(":");
    const isPrivate =
      isIpv4 ||
      isIpv6 ||
      host === "localhost" ||
      /\.(localhost|local|internal|localdomain|lan|home)$/.test(host) ||
      !host.includes(".") || // 单标签内网主机名
      /^169\.254\./.test(host) ||
      /^(10\.|127\.|192\.168\.)/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (url.protocol !== "https:" || isPrivate) {
      throw new Error("unsafe endpoint host");
    }
  } catch {
    throw errors.validation([
      { field: "/endpoint", message: "必须是公网 https 推送端点 URL" },
    ]);
  }
  const userId = c.get("userId");
  const existing = await c.env.DB_PRIVATE.prepare(
    "SELECT subscription_id, user_id FROM push_subscriptions WHERE endpoint = ?",
  )
    .bind(input.endpoint)
    .first<{ subscription_id: string; user_id: string }>();
  if (existing && existing.user_id !== userId) {
    // endpoint 是机密资源：他人订阅按冲突处理，不回显也不泄露存在性细节
    throw errors.conflict("该订阅端点已被使用");
  }
  try {
    if (existing) {
      await c.env.DB_PRIVATE.prepare(
        `UPDATE push_subscriptions
         SET p256dh = ?, auth = ?, status = 'active', last_seen_at = datetime('now')
         WHERE subscription_id = ? AND user_id = ?`,
      )
        .bind(
          input.keys.p256dh,
          input.keys.auth,
          existing.subscription_id,
          userId,
        )
        .run();
      return c.json({ subscription_id: existing.subscription_id }, 201);
    }
    const subscriptionId = `psub_${crypto.randomUUID()}`;
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        subscriptionId,
        userId,
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
      )
      .run();
    return c.json({ subscription_id: subscriptionId }, 201);
  } catch (e) {
    mapDbError(e); // endpoint UNIQUE 并发冲突 → 409
  }
});

// GET /me/push-subscriptions —— 仅聚合数（endpoint 含机密路径段，不回显列表）
meRoutes.get("/push-subscriptions", async (c) => {
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT COUNT(*) AS count,
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count
     FROM push_subscriptions WHERE user_id = ?`,
  )
    .bind(c.get("userId"))
    .first<{ count: number; active_count: number | null }>();
  return c.json({
    count: Number(row?.count ?? 0),
    active_count: Number(row?.active_count ?? 0),
  });
});

// DELETE /me/push-subscriptions —— body 携带 subscription_id；不存在/非本人 → 404
meRoutes.delete("/push-subscriptions", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(deletePushSubscriptionSchema, body);
  const { subscription_id: subscriptionId } = body as {
    subscription_id: string;
  };
  const res = await c.env.DB_PRIVATE.prepare(
    "DELETE FROM push_subscriptions WHERE subscription_id = ? AND user_id = ?",
  )
    .bind(subscriptionId, c.get("userId"))
    .run();
  if ((res.meta.changes ?? 0) === 0) throw errors.notFound("订阅不存在");
  return c.body(null, 204);
});

// ---------------- 摘要与账户 ----------------

// GET /me/digests —— 摘要生成属后续任务，框架先返回空列表（不造数）
meRoutes.get("/digests", (c) => c.json({ items: [], count: 0 }));

// POST /me/export —— TASK-07B：个人数据导出（JSON 单文件，PRD 行 703 可携带权）。
// 仅 session 用户数据（IDOR 天然隔离）；空对象 body（合同统一 JSON 体）。
meRoutes.post("/export", async (c) => {
  await jsonBody(c);
  const userId = c.get("userId");
  const db = c.env.DB_PRIVATE;
  const account = await db
    .prepare(
      `SELECT user_id, email_normalized, email_verified_at, status,
              created_at, last_login_at
       FROM users WHERE user_id = ?`,
    )
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!account) throw errors.notFound("用户不存在");
  const all = async (table: string): Promise<Record<string, unknown>[]> =>
    (
      await db
        .prepare(`SELECT * FROM ${table} WHERE user_id = ?`)
        .bind(userId)
        .all<Record<string, unknown>>()
    ).results;
  const payload = {
    schema_version: 1,
    exported_at: new Date().toISOString(),
    account,
    watch_items: await all("watch_items"),
    watch_rules: await all("watch_rules"),
    watch_rule_settings: await all("watch_rule_settings"),
    watch_item_groups: await all("watch_item_groups"),
    alert_events: await all("alert_events"),
    notification_preferences: await all("notification_preferences"),
    push_subscriptions: await all("push_subscriptions"),
    city_coverage_requests: await all("city_coverage_requests"),
    user_cities: await all("user_cities"),
    user_consents: await all("user_consents"),
  };
  c.header(
    "Content-Disposition",
    `attachment; filename="property-radar-export-${new Date().toISOString().slice(0, 10)}.json"`,
  );
  return c.json(payload);
});

// POST /me/delete-account —— TASK-07B：注销（冷静期 7 天 + 到期硬删，spec 2.2）。
// 请求即：标记 deletion_pending、吊销全部会话、清 cookie；期内重新登录撤销；
// 事件/邮件自动停止（requireSession 与 rules-engine/digest 只认 status='active'）。
// 幂等：重复调用返回同响应。
meRoutes.post("/delete-account", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(deleteAccountSchema, body);
  const userId = c.get("userId");
  const db = c.env.DB_PRIVATE;
  const user = await db
    .prepare("SELECT user_id, status, deleted_at FROM users WHERE user_id = ?")
    .bind(userId)
    .first<{ user_id: string; status: string; deleted_at: string | null }>();
  if (!user || user.deleted_at !== null) throw errors.notFound("用户不存在");
  const admin = await db
    .prepare(
      "SELECT admin_id FROM admin_roles WHERE user_id = ? AND revoked_at IS NULL LIMIT 1",
    )
    .bind(userId)
    .first();
  if (admin) throw errors.forbidden("管理员账号须先撤销角色后再注销");
  if (user.status !== "deletion_pending") {
    await db
      .prepare(
        `UPDATE users
         SET status = 'deletion_pending', deletion_requested_at = datetime('now')
         WHERE user_id = ?`,
      )
      .bind(userId)
      .run();
  }
  await db
    .prepare(
      `UPDATE sessions SET revoked_at = datetime('now')
       WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(userId)
    .run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({
    status: "deletion_pending",
    purge_after_days: DELETION_COOLDOWN_DAYS,
  });
});
