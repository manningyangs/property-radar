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

/** 通用空对象/无字段约束的 PATCH（如标记已读，仅要求是 JSON 对象） */
export const emptyObjectSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
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
