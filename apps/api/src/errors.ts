// TASK-02B：统一错误类型与稳定 error_code（PRD §10：所有错误有稳定 error_code）
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "bad_request"
  | "validation_failed"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "unsupported_media_type"
  | "rate_limited"
  | "not_implemented"
  | "service_unavailable"
  | "internal_error";

/** 业务/协议错误：携带 HTTP 状态与稳定 error_code，绝不携带内部结构（SQL、表名等） */
export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message = "请求无效") =>
    new AppError(400, "bad_request", message),
  validation: (
    details: Array<{ field: string; message: string }>,
    message = "请求参数校验失败",
  ) => new AppError(400, "validation_failed", message, details),
  unauthorized: (message = "需要登录后访问") =>
    new AppError(401, "unauthorized", message),
  notFound: (message = "资源不存在") => new AppError(404, "not_found", message),
  conflict: (message = "资源已存在或状态冲突") =>
    new AppError(409, "conflict", message),
  unsupportedMediaType: (message = "请求体必须为 application/json") =>
    new AppError(415, "unsupported_media_type", message),
  rateLimited: (message = "请求过于频繁，请稍后重试") =>
    new AppError(429, "rate_limited", message),
  notImplemented: (message = "该功能将在后续任务实现") =>
    new AppError(501, "not_implemented", message),
  unavailable: (message = "服务暂不可用，请稍后再试") =>
    new AppError(503, "service_unavailable", message),
  internal: (message = "服务器内部错误") =>
    new AppError(500, "internal_error", message),
};

/** 统一错误响应信封（不含任何私有 DB 结构信息） */
export function errorEnvelope(
  requestId: string,
  errorCode: ErrorCode,
  message: string,
  details?: Array<{ field: string; message: string }>,
): Record<string, unknown> {
  return {
    error_code: errorCode,
    message,
    request_id: requestId,
    ...(details && details.length > 0 ? { details } : {}),
  };
}
