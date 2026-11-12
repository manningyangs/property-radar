// TASK-02B：写接口 JSON Schema（PRD §10 统一 JSON Schema 校验）
// 枚举值与 db/migrations 的 CHECK 约束保持一致；PRD 未定义取值的字段用长度约束。
import type { AnySchema } from "ajv";

export const createWatchItemSchema: AnySchema = {
  type: "object",
  required: ["object_type", "object_id", "display_name_snapshot"],
  additionalProperties: false,
  properties: {
    object_type: { type: "string", enum: ["region", "community", "listing"] },
    object_id: { type: "string", minLength: 1, maxLength: 128 },
    display_name_snapshot: { type: "string", minLength: 1, maxLength: 200 },
    priority: { type: "integer", minimum: -100, maximum: 100 },
  },
};

export const patchWatchItemSchema: AnySchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: {
    display_name_snapshot: { type: "string", minLength: 1, maxLength: 200 },
    priority: { type: "integer", minimum: -100, maximum: 100 },
    status: { type: "string", enum: ["active", "archived"] },
  },
};

const RULE_PROPERTIES = {
  rule_type: { type: "string", minLength: 1, maxLength: 64 },
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
  target_value: { type: "number" },
  currency: { type: "string", minLength: 3, maxLength: 8 },
  unit: { type: "string", maxLength: 32 },
  window_days: { type: "integer", minimum: 1, maximum: 3650 },
  threshold_pct: { type: "number" },
  hysteresis_pct: { type: "number" },
  is_enabled: { type: "boolean" },
};

export const createRuleSchema: AnySchema = {
  type: "object",
  required: ["rule_type", "metric_code"],
  additionalProperties: false,
  properties: RULE_PROPERTIES,
};

export const patchRuleSchema: AnySchema = {
  type: "object",
  minProperties: 1,
  additionalProperties: false,
  properties: RULE_PROPERTIES,
};

export const patchPreferencesSchema: AnySchema = {
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
export const emptyObjectSchema: AnySchema = {
  type: "object",
  additionalProperties: false,
};

// ---------------- TASK-02C：认证（PRD §10.2） ----------------

/** 邮箱形态校验（不依赖 ajv-formats，纯 pattern，避免 strict 模式缺插件报错） */
const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

export const requestCodeSchema: AnySchema = {
  type: "object",
  required: ["email", "turnstile_token"],
  additionalProperties: false,
  properties: {
    email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
    turnstile_token: { type: "string", minLength: 1, maxLength: 2048 },
  },
};

export const verifyCodeSchema: AnySchema = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", pattern: EMAIL_PATTERN, maxLength: 254 },
    code: { type: "string", pattern: "^[0-9]{6}$" },
  },
};
