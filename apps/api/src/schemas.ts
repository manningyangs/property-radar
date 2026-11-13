// TASK-02B：写接口 JSON Schema（PRD §10 统一 JSON Schema 校验）
// 枚举值与 db/migrations 的 CHECK 约束保持一致；PRD 未定义取值的字段用长度约束。
// TASK-03B：rule_type 收紧为 PRD §4.6 五枚举，新增有效期与每规则通知渠道字段。
import { RULE_TYPES } from "@property-radar/shared";
import type { JsonSchema } from "./validation";

export const createWatchItemSchema: JsonSchema = {
  type: "object",
  required: ["object_type", "object_id", "display_name_snapshot"],
  additionalProperties: false,
  properties: {
    object_type: { type: "string", enum: ["region", "community", "listing"] },
    object_id: { type: "string", minLength: 1, maxLength: 128 },
    display_name_snapshot: { type: "string", minLength: 1, maxLength: 200 },
    priority: { type: "integer", minimum: -100, maximum: 100 },
    // TASK-03A：可选分组名（1–50 字符，与 0003 迁移 CHECK 约束一致）
    group_name: { type: "string", minLength: 1, maxLength: 50 },
  },
};

export const patchWatchItemSchema: JsonSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    display_name_snapshot: { type: "string", minLength: 1, maxLength: 200 },
    priority: { type: "integer", minimum: -100, maximum: 100 },
    // TASK-03A：状态枚举扩展 paused（暂停/恢复）
    status: { type: "string", enum: ["active", "paused", "archived"] },
    // TASK-03A：字符串=入组/改组，null=移出分组
    group_name: {
      type: ["string", "null"],
      minLength: 1,
      maxLength: 50,
    },
  },
};

const RULE_PROPERTIES = {
  // TASK-03B：规则类型枚举（PRD §4.6 五种），语义绑定由 shared.validateRuleBinding 交叉校验
  rule_type: { type: "string", enum: [...RULE_TYPES] },
  metric_code: { type: "string", minLength: 1, maxLength: 64 },
  price_type: {
    type: "string",
    enum: [
      "listing_ask",
      "closed_transaction",
      "official_index",
      "user_reported",
      "model_estimate",
    ],
  },
  // 可空：PATCH 允许清空（如 lte → 跌幅规则时置 null），语义层校验必填/禁止
  target_value: { type: ["number", "null"], minimum: 0 },
  currency: { type: "string", minLength: 3, maxLength: 8 },
  unit: { type: ["string", "null"], maxLength: 32 },
  window_days: { type: ["integer", "null"], minimum: 1, maximum: 3650 },
  threshold_pct: { type: ["number", "null"], minimum: 0, maximum: 100 },
  // re-arm 缓冲幅度（§4.6-5：价格回到目标上方超过该幅度才重新武装）
  hysteresis_pct: { type: ["number", "null"], minimum: 0, maximum: 100 },
  is_enabled: { type: "boolean" },
  // TASK-03B：有效期（YYYY-MM-DD / null=长期有效）
  valid_until: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  // TASK-03B：每规则独立通知渠道（与用户级 notification_preferences 并存）
  notify_email: { type: "boolean" },
  notify_digest: { type: "boolean" },
  notify_inapp: { type: "boolean" },
};

export const createRuleSchema: JsonSchema = {
  type: "object",
  required: ["rule_type", "metric_code"],
  additionalProperties: false,
  properties: RULE_PROPERTIES,
};

export const patchRuleSchema: JsonSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: RULE_PROPERTIES,
};

export const patchPreferencesSchema: JsonSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    email_enabled: { type: "boolean" },
    digest_enabled: { type: "boolean" },
    digest_time: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
    browser_push_enabled: { type: "boolean" },
    timezone: { type: "string", minLength: 1, maxLength: 64 },
  },
};

// ---------------- TASK-05C：浏览器推送订阅（spec §3.2） ----------------

/** base64url 形态（无 padding：仅 A-Z a-z 0-9 - _） */
const BASE64URL_PATTERN = "^[A-Za-z0-9_-]+$";

/** 创建/更新推送订阅：endpoint 为 http(s) URL，keys 为 RFC 8291 订阅密钥 */
export const createPushSubscriptionSchema: JsonSchema = {
  type: "object",
  required: ["endpoint", "keys"],
  additionalProperties: false,
  properties: {
    endpoint: { type: "string", pattern: "^https?://", maxLength: 2048 },
    keys: {
      type: "object",
      required: ["p256dh", "auth"],
      additionalProperties: false,
      properties: {
        p256dh: { type: "string", pattern: BASE64URL_PATTERN, minLength: 1 },
        auth: { type: "string", pattern: BASE64URL_PATTERN, minLength: 1 },
      },
    },
  },
};

/** 删除推送订阅：按 subscription_id 定位（不存在/非本人 → 404） */
export const deletePushSubscriptionSchema: JsonSchema = {
  type: "object",
  required: ["subscription_id"],
  additionalProperties: false,
  properties: {
    subscription_id: { type: "string", minLength: 1, maxLength: 128 },
  },
};

/** 通用空对象/无字段约束的 PATCH（如标记已读，仅要求是 JSON 对象） */
export const emptyObjectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
};

/** TASK-05A：PATCH /me/events/:id/read —— { read?: boolean }，缺省/true=已读，false=标记未读 */
export const eventReadSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    read: { type: "boolean" },
  },
};

// ---------------- TASK-02C：认证（PRD §10.2） ----------------

/** 邮箱形态校验（不依赖 ajv-formats，纯 pattern，避免 strict 模式缺插件报错） */
const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

export const requestCodeSchema: JsonSchema = {
  type: "object",
  required: ["email", "turnstile_token"],
  additionalProperties: false,
  properties: {
    email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
    turnstile_token: { type: "string", minLength: 1, maxLength: 2048 },
  },
};

export const verifyCodeSchema: JsonSchema = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
};

// ---------------- TASK-04A：数据源登记与审批（PRD 任务行 1280–1286 / §10.4 / §10.5） ----------------

/** YYYY-MM-DD 日期形态（与 0002/0005 迁移 GLOB CHECK 一致） */
const DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/** 监控对象层级（与 source_city_coverage.object_level CHECK 一致） */
const OBJECT_LEVELS = ["city", "district", "community", "listing"];

/** 登记数据源（状态一律落 discovered，状态只能走 approve/suspend 端点） */
export const createSourceSchema: JsonSchema = {
  type: "object",
  required: ["source_id", "name", "source_type"],
  additionalProperties: false,
  properties: {
    source_id: { type: "string", pattern: "^[a-z][a-z0-9_]{2,63}$" },
    name: { type: "string", minLength: 1, maxLength: 100 },
    source_type: { type: "string", minLength: 1, maxLength: 32 },
    official_url: { type: "string", minLength: 1, maxLength: 500 },
    data_scope: { type: "string", minLength: 1, maxLength: 500 },
    license_note_url: { type: "string", minLength: 1, maxLength: 500 },
    display_scope: { type: "string", minLength: 1, maxLength: 500 },
  },
};

/** 仅元数据编辑：不含 status（状态只能经审批/停用端点变更），可空字段用 null 清除 */
export const patchSourceSchema: JsonSchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 100 },
    source_type: { type: "string", minLength: 1, maxLength: 32 },
    official_url: { type: ["string", "null"], maxLength: 500 },
    data_scope: { type: ["string", "null"], maxLength: 500 },
    license_note_url: { type: ["string", "null"], maxLength: 500 },
    display_scope: { type: ["string", "null"], maxLength: 500 },
  },
};

/**
 * 审批（PRD §5.3-2/450：不能仅勾选"已授权"，必须附审批人证据、范围、字段、用途、频率与保存期限；
 * coverage=授权覆盖的城市/层级/指标范围，approve 时 upsert source_city_coverage）。
 */
export const approveSourceSchema: JsonSchema = {
  type: "object",
  required: [
    "status",
    "evidence_ref",
    "permitted_fields",
    "permitted_purposes",
    "frequency",
    "retention_period",
    "coverage",
  ],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["approved_open", "approved_licensed"] },
    evidence_ref: { type: "string", minLength: 3, maxLength: 500 },
    permitted_fields: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    permitted_purposes: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1, maxLength: 64 },
    },
    frequency: { type: "string", minLength: 1, maxLength: 100 },
    retention_period: { type: "string", minLength: 1, maxLength: 100 },
    coverage: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["city_code", "object_level", "metric_codes"],
        additionalProperties: false,
        properties: {
          city_code: { type: "string", minLength: 1, maxLength: 32 },
          object_level: { type: "string", enum: OBJECT_LEVELS },
          metric_codes: {
            type: "array",
            minItems: 1,
            items: { type: "string", minLength: 1, maxLength: 64 },
          },
        },
      },
    },
    // 授权到期日（到期后由门禁惰性自动 suspend）；缺省 null=不设到期
    valid_until: { type: ["string", "null"], pattern: DATE_PATTERN },
    note: { type: "string", maxLength: 500 },
  },
};

/** 停用数据源（reason 必填，写 audit_logs；coverage 全量同步 suspended） */
export const suspendSourceSchema: JsonSchema = {
  type: "object",
  required: ["reason"],
  additionalProperties: false,
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
};

/**
 * TASK-04D：单条价格观测（spec R2；字段与 price_observations CHECK 对齐）。
 * 口径约束由端点语义校验：总价与单价至少一项非空、area_sqm > 0。
 */
const OBSERVATION_ITEM_SCHEMA: JsonSchema = {
  type: "object",
  required: ["object_id", "price_type", "metric_code", "stat_date"],
  additionalProperties: false,
  properties: {
    object_id: { type: "string", minLength: 1, maxLength: 128 },
    property_type: {
      type: ["string", "null"],
      enum: ["new_build", "resale", null],
    },
    price_type: {
      type: "string",
      enum: [
        "listing_ask",
        "closed_transaction",
        "official_index",
        "user_reported",
        "model_estimate",
      ],
    },
    metric_code: { type: "string", minLength: 1, maxLength: 64 },
    // TASK-04E：指数值（spec R3——仅 official_index 携带，0 < v ≤ 1000；
    // 价格类观测是否携带 index_value 由 cleaning 语义互斥拒绝）
    index_value: {
      type: ["number", "null"],
      exclusiveMinimum: 0,
      maximum: 1000,
    },
    price_total_fen: { type: ["integer", "null"], minimum: 0 },
    unit_price_yuan_sqm: { type: ["integer", "null"], minimum: 0 },
    area_sqm: { type: ["number", "null"], minimum: 0 },
    sample_count: { type: "integer", minimum: 0 },
    stat_date: { type: "string", pattern: DATE_PATTERN },
    quality_status: {
      type: "string",
      enum: ["valid", "low_sample", "stale", "outlier", "rejected"],
    },
    connector_version: { type: ["string", "null"], maxLength: 32 },
  },
};

/** internal 批次受理（04A 门禁与受理记录；04D 增 observations 明细落库，清洗仍属 04E） */
export const ingestBatchSchema: JsonSchema = {
  type: "object",
  required: ["batch_id", "source_id", "city_code", "object_level"],
  additionalProperties: false,
  properties: {
    batch_id: { type: "string", minLength: 1, maxLength: 128 },
    source_id: { type: "string", minLength: 1, maxLength: 64 },
    city_code: { type: "string", minLength: 1, maxLength: 32 },
    object_level: { type: "string", enum: OBJECT_LEVELS },
    observed_count: { type: "integer", minimum: 0 },
    // TASK-04D：批内观测明细（可选；存在时 observed_count 必须等于其长度，由端点交叉校验）
    observations: {
      type: "array",
      maxItems: 500,
      items: OBSERVATION_ITEM_SCHEMA,
    },
  },
};

/**
 * internal 任务开始（04B / §10.4 / §11.1-2）：object_level 供 source-gate 门禁校验，
 * 未 approved 来源连任务都起不来；任务本身不携带观测明细。
 */
export const ingestJobStartSchema: JsonSchema = {
  type: "object",
  required: ["job_id", "source_id", "city_code", "object_level"],
  additionalProperties: false,
  properties: {
    job_id: { type: "string", minLength: 1, maxLength: 128 },
    source_id: { type: "string", minLength: 1, maxLength: 64 },
    city_code: { type: "string", minLength: 1, maxLength: 32 },
    object_level: { type: "string", enum: OBJECT_LEVELS },
  },
};

/** internal 任务完成：status 只允许成败二态；重复 finish 由端点幂等处理 */
export const ingestJobFinishSchema: JsonSchema = {
  type: "object",
  required: ["status"],
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["succeeded", "failed"] },
    error_code: { type: "string", minLength: 1, maxLength: 64 },
    note: { type: "string", maxLength: 500 },
  },
};

/** internal 来源健康上报：不设资格门禁（down/degraded 恰恰要能记录） */
export const sourceHealthSchema: JsonSchema = {
  type: "object",
  required: ["source_id", "status"],
  additionalProperties: false,
  properties: {
    source_id: { type: "string", minLength: 1, maxLength: 64 },
    status: { type: "string", enum: ["ok", "degraded", "down"] },
    latency_ms: { type: "integer", minimum: 0 },
    detail: { type: "string", maxLength: 500 },
  },
};

/** internal 资格预检：city_code/object_level 必须同给同缺（由端点校验），仅 source_id = 只查许可状态 */
export const sourceEligibilitySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    city_code: { type: "string", minLength: 1, maxLength: 32 },
    object_level: { type: "string", enum: OBJECT_LEVELS },
  },
};

/**
 * TASK-04D：admin 手工补录单条观测（spec R2）——观测字段 + source_id；
 * price_type 限手工核验两类（user_reported / listing_ask），其余口径复用 OBSERVATION_ITEM_SCHEMA。
 */
export const createObservationSchema: JsonSchema = {
  type: "object",
  required: [
    "source_id",
    "object_id",
    "price_type",
    "metric_code",
    "stat_date",
  ],
  additionalProperties: false,
  properties: {
    source_id: { type: "string", minLength: 1, maxLength: 64 },
    ...(OBSERVATION_ITEM_SCHEMA.properties as Record<string, JsonSchema>),
    price_type: { type: "string", enum: ["user_reported", "listing_ask"] },
  },
};
