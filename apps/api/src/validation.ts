// TASK-02B：JSON Schema 校验（PRD §10：所有 POST/PUT/PATCH 使用 JSON Schema 校验）
import Ajv, {
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import { AppError, errors } from "./errors";

const ajv = new Ajv({ allErrors: true, strict: true });

const cache = new WeakMap<object, ValidateFunction>();

function getValidator(schema: AnySchema): ValidateFunction {
  if (typeof schema === "object" && schema !== null) {
    const cached = cache.get(schema);
    if (cached) return cached;
    const compiled = ajv.compile(schema);
    cache.set(schema, compiled);
    return compiled;
  }
  return ajv.compile(schema);
}

function toDetails(errs: ErrorObject[] | null | undefined): Array<{
  field: string;
  message: string;
}> {
  return (errs ?? []).map((e) => ({
    field: e.instancePath && e.instancePath.length > 0 ? e.instancePath : "/",
    // 只输出约束说明，不回显用户提交的值（避免日志/响应二次泄露）
    message: e.message ?? "取值不合法",
  }));
}

/** 校验不通过抛出 400 validation_failed（details 仅含字段路径与约束说明） */
export function validateOrThrow(schema: AnySchema, data: unknown): void {
  const validate = getValidator(schema);
  if (!validate(data)) {
    throw errors.validation(toDetails(validate.errors));
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
      throw errors.badRequest("请求体必须为 JSON 对象");
    }
    return parsed;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw errors.badRequest("请求体不是合法 JSON");
  }
}
