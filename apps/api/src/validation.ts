// TASK-02B：请求校验（PRD §10：所有 POST/PATCH 使用 JSON Schema 校验）
// TASK-03A：Ajv 替换为手写 JSON Schema 子集解释器。
//   背景：Cloudflare Workers/workerd 全局禁用 eval/new Function（无兼容开关），
//   Ajv 运行时编译 schema 会抛 "Code generation from strings disallowed" 导致
//   所有校验端点 500；单测跑在 Node 里无法复现，故此前未暴露。
//   方案：直接解释本项目 schemas.ts 用到的关键字子集——无依赖、无代码生成、
//   Node 与 Workers 行为一致；遇到白名单外的关键字立即抛错（等价于 ajv strict，
//   保证新增 schema 关键字时测试会红，而不是静默跳过校验）。
import { AppError, errors } from "./errors";

/** JSON Schema 对象（本项目只用无嵌套 $ref 的扁平结构） */
export type JsonSchema = Record<string, unknown>;

interface FieldError {
  field: string;
  message: string;
}

// 支持的关键字白名单（覆盖 schemas.ts 全部用法）
const SUPPORTED_KEYWORDS = new Set([
  "type",
  "required",
  "additionalProperties",
  "properties",
  "enum",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  // TASK-04E：指数值下界排他（0 < v ≤ 1000，spec R3）
  "exclusiveMinimum",
  "minProperties",
  // TASK-04A：approve 的 coverage 数组（元素对象 schema 递归 + 至少 1 项）
  "items",
  "minItems",
  // TASK-04D：批次观测数组上限（spec R2 maxItems 500）
  "maxItems",
]);

const SUPPORTED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const TYPE_LABELS: Record<string, string> = {
  object: "对象",
  array: "数组",
  string: "字符串",
  number: "数字",
  integer: "整数",
  boolean: "布尔值",
  null: "null",
};

// pattern 只在 schema 里静态出现，缓存避免重复编译
const patternCache = new Map<string, RegExp>();
function getPattern(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    patternCache.set(pattern, re);
  }
  return re;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeMatches(data: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(data);
    case "array":
      return Array.isArray(data);
    case "string":
      return typeof data === "string";
    case "number":
      return typeof data === "number" && Number.isFinite(data);
    case "integer":
      return typeof data === "number" && Number.isInteger(data);
    case "boolean":
      return typeof data === "boolean";
    case "null":
      return data === null;
    default:
      // 未知类型由白名单在归一化阶段拦截，这里不可达
      throw new Error(`未知 schema 类型: ${type}`);
  }
}

/** 归一化 type（字符串或字符串数组），未知关键字/类型直接抛错 */
function normalizeTypes(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`非法的 schema type: ${JSON.stringify(raw)}`);
  }
  for (const t of list) {
    if (typeof t !== "string" || !SUPPORTED_TYPES.has(t)) {
      throw new Error(`不支持的 schema type: ${JSON.stringify(t)}`);
    }
  }
  return list as string[];
}

/** 错误字段路径：根为 "/"，属性为 "/prop"（与原 ajv instancePath 对齐） */
function fieldOf(path: string): string {
  return path.length > 0 ? path : "/";
}

function push(out: FieldError[], path: string, message: string): void {
  out.push({ field: fieldOf(path), message });
}

/** 递归校验：把全部错误收集到 out（等价 ajv allErrors: true） */
function collect(
  schema: JsonSchema,
  data: unknown,
  path: string,
  out: FieldError[],
): void {
  for (const kw of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(kw)) {
      throw new Error(`不支持的 JSON Schema 关键字: ${kw}`);
    }
  }

  const types = normalizeTypes(schema.type);

  // type（数组形态支持 null 联合，如 ["string","null"]）
  if (types) {
    const ok = types.some((t) => typeMatches(data, t));
    if (!ok) {
      const labels = types.map((t) => TYPE_LABELS[t] ?? t);
      push(
        out,
        path,
        `必须是${labels.join(" 或 ")}${
          types.includes("null") ? "" : `（收到 ${describe(data)}）`
        }`,
      );
    }
  }

  // enum：不依赖 type，任何取值都参与比对（与 ajv 一致）
  if (Array.isArray(schema.enum) && !schema.enum.includes(data)) {
    push(out, path, "取值不在允许范围内");
  }

  // 字符串关键字（仅对 string 生效，与 ajv 的 typeof 守卫一致）
  if (typeof data === "string") {
    if (
      typeof schema.minLength === "number" &&
      data.length < schema.minLength
    ) {
      push(out, path, `长度不能少于 ${schema.minLength} 个字符`);
    }
    if (
      typeof schema.maxLength === "number" &&
      data.length > schema.maxLength
    ) {
      push(out, path, `长度不能超过 ${schema.maxLength} 个字符`);
    }
    if (
      typeof schema.pattern === "string" &&
      !getPattern(schema.pattern).test(data)
    ) {
      push(out, path, "格式不符合要求");
    }
  }

  // 数值关键字（仅对有限数字生效）
  if (typeof data === "number" && Number.isFinite(data)) {
    if (typeof schema.minimum === "number" && data < schema.minimum) {
      push(out, path, `不能小于 ${schema.minimum}`);
    }
    if (
      typeof schema.exclusiveMinimum === "number" &&
      data <= schema.exclusiveMinimum
    ) {
      push(out, path, `不能小于或等于 ${schema.exclusiveMinimum}`);
    }
    if (typeof schema.maximum === "number" && data > schema.maximum) {
      push(out, path, `不能大于 ${schema.maximum}`);
    }
  }

  // 数组关键字（TASK-04A：minItems 约束 + items 元素 schema 递归校验）
  if (Array.isArray(data)) {
    if (typeof schema.minItems === "number" && data.length < schema.minItems) {
      push(out, path, `至少需要 ${schema.minItems} 个元素`);
    }
    if (typeof schema.maxItems === "number" && data.length > schema.maxItems) {
      push(out, path, `元素数量不能超过 ${schema.maxItems} 个`);
    }
    if (isPlainObject(schema.items)) {
      const itemSchema = schema.items as JsonSchema;
      data.forEach((item, i) => {
        collect(itemSchema, item, `${path}/${i}`, out);
      });
    }
  }

  // 对象关键字
  if (isPlainObject(data)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in data)) {
          push(out, path, `缺少必需字段 ${key}`);
        }
      }
    }
    if (
      typeof schema.minProperties === "number" &&
      Object.keys(data).length < schema.minProperties
    ) {
      push(out, path, `至少需要 ${schema.minProperties} 个字段`);
    }
    const props = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in data) {
        if (!isPlainObject(sub)) {
          throw new Error(`字段 ${key} 的 schema 必须是对象`);
        }
        collect(sub, data[key], `${path}/${key}`, out);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(data)) {
        if (!(key in props)) {
          push(out, path, `不允许的字段 ${key}`);
        }
      }
    }
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  const t = typeof v;
  if (t === "object") return "对象";
  if (t === "string") return "字符串值";
  if (t === "number") return "数字值";
  if (t === "boolean") return "布尔值";
  return t;
}

/** 校验不通过抛出 400 validation_failed（details 仅含字段路径与约束说明） */
export function validateOrThrow(schema: JsonSchema, data: unknown): void {
  const out: FieldError[] = [];
  collect(schema, data, "", out);
  if (out.length > 0) {
    throw errors.validation(out);
  }
}

/** 解析并校验 JSON 请求体：非 JSON → 415；非法 JSON/空体 → 400 */
export async function readJsonBody(
  contentType: string | undefined,
  readText: () => Promise<string>,
): Promise<unknown> {
  if (!contentType || !contentType.toLowerCase().includes("application/json")) {
    throw errors.unsupportedMediaType();
  }
  const raw = await readText();
  if (!raw.trim()) throw errors.badRequest("请求体不能为空");
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      throw errors.badRequest("请求体必须是 JSON 对象");
    }
    return parsed;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.badRequest("请求体不是合法 JSON");
  }
}
