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
  | "internal_error"
  // ---- TASK-04A：数据源审批与批次门禁（稳定错误码，PRD 任务行 1286 验收） ----
  | "admin_required"
  | "source_not_found"
  | "source_not_approved"
  | "city_coverage_denied"
  | "ingest_disabled"
  | "signature_invalid"
  | "stale_timestamp"
  | "replay_detected"
  // ---- TASK-04B：任务与健康记录 ----
  | "job_not_found"
  // ---- TASK-06A：后台认证与权限（管理员 MFA / bootstrap / 审计查询） ----
  | "mfa_required"
  | "mfa_not_enrolled"
  | "mfa_invalid_code"
  | "mfa_conflict"
  | "bootstrap_not_configured"
  | "bootstrap_code_invalid"
  | "bootstrap_target_not_found"
  // ---- TASK-08C：城市覆盖申请 ----
  | "already_requested";

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
  /** TASK-07B：会话有效但业务规则禁止（如管理员角色未撤销时注销） */
  forbidden: (message = "操作不被允许") =>
    new AppError(403, "forbidden", message),
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
  // ---- TASK-04A：数据源审批与批次门禁 ----
  /** 已登录但没有 admin_roles 有效角色（普通用户越权访问 /admin/*） */
  adminRequired: (message = "需要管理员权限") =>
    new AppError(403, "admin_required", message),
  /** 数据源目录中不存在该 source_id */
  sourceNotFound: (message = "数据源不存在") =>
    new AppError(404, "source_not_found", message),
  /** 来源状态不允许自动采集（pending_review/suspended/过期等，PRD 04A 验收） */
  sourceNotApproved: (message = "数据源未获自动采集许可") =>
    new AppError(403, "source_not_approved", message),
  /** 覆盖城市/层级超范围或城市未开通（PRD 04A「拒绝超范围批次」验收） */
  cityCoverageDenied: (message = "批次超出数据源授权覆盖范围") =>
    new AppError(403, "city_coverage_denied", message),
  /** INGEST_HMAC_SECRET 未配置，internal 端点整体禁用 */
  ingestDisabled: (message = "数据导入端点未启用") =>
    new AppError(403, "ingest_disabled", message),
  /** HMAC 签名不匹配 */
  signatureInvalid: (message = "批次签名验证失败") =>
    new AppError(403, "signature_invalid", message),
  /** 时间戳缺失或偏差超限 */
  staleTimestamp: (message = "请求时间戳超出允许偏差") =>
    new AppError(403, "stale_timestamp", message),
  /** nonce 已使用（防重放） */
  replayDetected: (message = "检测到重复请求（nonce 已使用）") =>
    new AppError(403, "replay_detected", message),
  // ---- TASK-04B：任务与健康记录 ----
  /** finish 的 job_id 在 ingest_jobs 中不存在 */
  jobNotFound: (message = "采集任务不存在") =>
    new AppError(404, "job_not_found", message),
  // ---- TASK-06A：后台认证与权限 ----
  /** 管理员会话未完成 TOTP 二次验证（每登录会话独立验证） */
  mfaRequired: (message = "请先完成管理员二次验证") =>
    new AppError(403, "mfa_required", message),
  /** 该管理员尚未绑定 TOTP 密钥（需先 setup） */
  mfaNotEnrolled: (message = "尚未绑定验证器，请先完成设置") =>
    new AppError(403, "mfa_not_enrolled", message),
  /** TOTP 验证码错误、格式非法或已过期（含重放拒绝） */
  mfaInvalidCode: (message = "验证码错误或已过期") =>
    new AppError(400, "mfa_invalid_code", message),
  /** 已绑定且确认的密钥重复 setup（需先 disable） */
  mfaConflict: (message = "已绑定验证器，请先解除后再重新绑定") =>
    new AppError(409, "mfa_conflict", message),
  /** ADMIN_BOOTSTRAP_CODE 未配置，首次创建管理员端点禁用 */
  bootstrapNotConfigured: (message = "管理员初始化端点未启用") =>
    new AppError(503, "bootstrap_not_configured", message),
  /** bootstrap code 缺失或不匹配 */
  bootstrapCodeInvalid: (message = "初始化代码无效") =>
    new AppError(403, "bootstrap_code_invalid", message),
  /** bootstrap 目标邮箱不存在 */
  bootstrapTargetNotFound: (message = "目标用户不存在") =>
    new AppError(404, "bootstrap_target_not_found", message),
  // ---- TASK-08C：城市覆盖申请 ----
  /** 同人同城已有处理中的覆盖申请（幂等拒绝，防刷队列） */
  alreadyRequested: (
    message = "您已提交该城市的覆盖申请，正在评估中，请耐心等待",
  ) => new AppError(409, "already_requested", message),
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
