// TASK-02B：用户 API（PRD §10.3 /me/*）——强制登录，所有读写按 user_id 隔离。
// 跨用户访问一律返回 404（不泄露他人资源是否存在，PRD §12.0-5/验收）。
import { Hono, type Context } from "hono";
import { requireSession } from "../auth";
import { errors } from "../errors";
import { type AppEnv } from "../env";
import { readJsonBody, validateOrThrow } from "../validation";
import {
  createRuleSchema,
  createWatchItemSchema,
  emptyObjectSchema,
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

// GET /me/watch-items
meRoutes.get("/watch-items", async (c) => {
  const res = await c.env.DB_PRIVATE.prepare(
    `SELECT ${WATCH_COLUMNS} FROM watch_items
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT 50`,
  )
    .bind(c.get("userId"))
    .all<WatchRow>();
  return c.json({ items: res.results, count: res.results.length });
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
  };
  const watchId = crypto.randomUUID();
  try {
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO watch_items
         (watch_id, user_id, object_type, object_id, display_name_snapshot, priority, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', datetime('now'))`,
    )
      .bind(
        watchId,
        c.get("userId"),
        input.object_type,
        input.object_id,
        input.display_name_snapshot,
        input.priority ?? 0,
      )
      .run();
  } catch (e) {
    mapDbError(e);
  }
  const item = await loadOwnWatch(c, c.get("userId"), watchId);
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
  } catch (e) {
    mapDbError(e);
  }
  return c.json({ item: await loadOwnWatch(c, userId, watchId) });
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

// ---------------- 监控规则 ----------------

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

// GET /me/watch-items/:id/rules
meRoutes.get("/watch-items/:id/rules", async (c) => {
  const userId = c.get("userId");
  await loadOwnWatch(c, userId, c.req.param("id"));
  const res = await c.env.DB_PRIVATE.prepare(
    `SELECT ${RULE_COLUMNS} FROM watch_rules
     WHERE watch_id = ? AND user_id = ?
     ORDER BY created_at DESC LIMIT 50`,
  )
    .bind(c.req.param("id"), userId)
    .all<RuleRow>();
  return c.json({ items: res.results, count: res.results.length });
});

// POST /me/watch-items/:id/rules
meRoutes.post("/watch-items/:id/rules", async (c) => {
  const userId = c.get("userId");
  const watchId = c.req.param("id");
  await loadOwnWatch(c, userId, watchId);
  const body = await jsonBody(c);
  validateOrThrow(createRuleSchema, body);
  const input = body as {
    rule_type: string;
    metric_code: string;
    price_type?: string;
    target_value?: number;
    currency?: string;
    unit?: string;
    window_days?: number;
    threshold_pct?: number;
    hysteresis_pct?: number;
    is_enabled?: boolean;
  };
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
  } catch (e) {
    mapDbError(e);
  }
  const item = await c.env.DB_PRIVATE.prepare(
    `SELECT ${RULE_COLUMNS} FROM watch_rules WHERE rule_id = ? AND user_id = ?`,
  )
    .bind(ruleId, userId)
    .first<RuleRow>();
  return c.json({ item }, 201);
});

async function loadOwnRule(
  c: Context<AppEnv>,
  userId: string,
  ruleId: string,
): Promise<RuleRow> {
  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT ${RULE_COLUMNS} FROM watch_rules WHERE rule_id = ? AND user_id = ?`,
  )
    .bind(ruleId, userId)
    .first<RuleRow>();
  if (!row) throw errors.notFound("规则不存在");
  return row;
}

// PATCH /me/rules/:id
meRoutes.patch("/rules/:id", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("id");
  const body = await jsonBody(c);
  validateOrThrow(patchRuleSchema, body);
  const patch = body as Record<string, unknown>;
  await loadOwnRule(c, userId, ruleId);
  const sets: string[] = ["updated_at = datetime('now')"];
  const params: Array<string | number | null> = [];
  const columns = new Set([
    "rule_type",
    "metric_code",
    "price_type",
    "target_value",
    "currency",
    "unit",
    "window_days",
    "threshold_pct",
    "hysteresis_pct",
  ]);
  for (const [key, value] of Object.entries(patch)) {
    if (key === "is_enabled") {
      sets.push("is_enabled = ?");
      params.push(value ? 1 : 0);
      continue;
    }
    if (columns.has(key)) {
      sets.push(`${key} = ?`);
      params.push(value as string | number | null);
    }
  }
  params.push(ruleId, userId);
  await c.env.DB_PRIVATE.prepare(
    `UPDATE watch_rules SET ${sets.join(", ")} WHERE rule_id = ? AND user_id = ?`,
  )
    .bind(...params)
    .run();
  return c.json({ item: await loadOwnRule(c, userId, ruleId) });
});

// DELETE /me/rules/:id
meRoutes.delete("/rules/:id", async (c) => {
  const userId = c.get("userId");
  const ruleId = c.req.param("id");
  await loadOwnRule(c, userId, ruleId);
  await c.env.DB_PRIVATE.prepare(
    "DELETE FROM watch_rules WHERE rule_id = ? AND user_id = ?",
  )
    .bind(ruleId, userId)
    .run();
  return c.json({ deleted: true });
});

// ---------------- 事件 ----------------

// GET /me/events?unread=&limit=
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
  const where = ["user_id = ?"];
  const params: Array<string | number> = [c.get("userId")];
  if (unread === "true") where.push("read_at IS NULL");
  params.push(limit);
  const res = await c.env.DB_PRIVATE.prepare(
    `SELECT event_id, rule_id, watch_id, event_type, old_value, new_value,
            target_value, difference_pct, status, created_at, read_at
     FROM alert_events
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(...params)
    .all();
  return c.json({ items: res.results, count: res.results.length });
});

// PATCH /me/events/:id/read —— 标记已读（幂等）
meRoutes.patch("/events/:id/read", async (c) => {
  const userId = c.get("userId");
  const eventId = c.req.param("id");
  const body = await jsonBody(c);
  validateOrThrow(emptyObjectSchema, body);
  const row = await c.env.DB_PRIVATE.prepare(
    "SELECT event_id FROM alert_events WHERE event_id = ? AND user_id = ?",
  )
    .bind(eventId, userId)
    .first();
  if (!row) throw errors.notFound("事件不存在");
  await c.env.DB_PRIVATE.prepare(
    `UPDATE alert_events
     SET read_at = COALESCE(read_at, datetime('now')), status = 'read'
     WHERE event_id = ? AND user_id = ?`,
  )
    .bind(eventId, userId)
    .run();
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

// ---------------- 摘要与账户 ----------------

// GET /me/digests —— 摘要生成属后续任务，框架先返回空列表（不造数）
meRoutes.get("/digests", (c) => c.json({ items: [], count: 0 }));

// POST /me/export / POST /me/delete-account —— 合同已定义，功能后续任务实现
meRoutes.post("/export", async (c) => {
  await jsonBody(c);
  throw errors.notImplemented();
});
meRoutes.post("/delete-account", async (c) => {
  await jsonBody(c);
  throw errors.notImplemented();
});
