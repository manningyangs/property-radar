// TASK-04A/04B：internal 数据导入端点（PRD 任务行 1285 / §10.4：HMAC 签名、时间戳、nonce 防重放、固定来源 ID 与批次 ID）
// 校验顺序（04A spec）：密钥就绪 → 时间戳（±300s）→ nonce 落库（冲突即重放）→ HMAC 签名 → body schema → 门禁 → 受理。
// 04A 原则上门禁与受理记录（ingest_batches）即止；04D 按负责人拍板扩展：批内带 observations 时落明细并聚合快照（清洗规则仍属 TASK-04E）。
// 04B 新增：共享签名链（verifySignedRequest，行为与 04A 逐字节一致）+ 任务开始/完成 + 来源健康 + 资格预检四端点。
// 签名口径：HMAC-SHA256(INGEST_HMAC_SECRET, `${timestamp}.${nonce}.${rawBody}`) 的小写 hex；
// 任何失败只回稳定 error_code，绝不回显 secret 或内部细节。
import { Hono } from "hono";
import type { Context } from "hono";
import { AUTOMATION_ALLOWED_STATUSES } from "@property-radar/shared";
import { errors } from "../errors";
import { type AppEnv } from "../env";
import { validateOrThrow } from "../validation";
import {
  ingestBatchSchema,
  ingestJobFinishSchema,
  ingestJobStartSchema,
  sourceEligibilitySchema,
  sourceHealthSchema,
} from "../schemas";
import { assertIngestAllowed, resolveLicense } from "../source-gate";
import {
  assertObservationSemantics,
  writeObservations,
  type ObservationInput,
} from "../observations";

/** 时间戳允许偏差（秒）——覆盖人工时钟漂移，同时限定重放窗口 */
const TIMESTAMP_MAX_SKEW_SEC = 300;
/** nonce 台账保留时长（秒）：远大于重放窗口，到期可清理 */
const NONCE_TTL_SEC = 3600;
/** nonce 形态：高熵、可入 SQL 主键 */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const internalRoutes = new Hono<AppEnv>();

/** HMAC-SHA256 → 小写 hex（Web Crypto，Workers 与 Node 一致） */
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 定长比较（不泄露已匹配前缀） */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1)
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 共享签名校验链（04A 提取，全部 /internal/* 端点复用）：
 * 密钥就绪 → 读原始 body → 时间戳 ±300s → nonce 防重放（INSERT 冲突即重放）→ HMAC 定长比较。
 * 错误码与顺序和 04A ingest/batch 完全一致；任何失败不回显 secret。
 * @returns 原始请求体（供调用方 JSON.parse + schema 校验）
 */
async function verifySignedRequest(c: Context<AppEnv>): Promise<string> {
  const secret = c.env.INGEST_HMAC_SECRET?.trim();
  if (!secret) throw errors.ingestDisabled();

  // 1) 时间戳
  const raw = await c.req.text();
  const tsHeader = c.req.header("x-ingest-timestamp") ?? "";
  if (!/^\d{1,15}$/.test(tsHeader)) throw errors.staleTimestamp();
  const tsSec = Number(tsHeader);
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsSec) > TIMESTAMP_MAX_SKEW_SEC) {
    throw errors.staleTimestamp();
  }

  // 2) nonce 防重放：先清理过期台账，再 INSERT（主键冲突 = 同请求二次到达）
  const nonce = c.req.header("x-ingest-nonce") ?? "";
  if (!NONCE_PATTERN.test(nonce)) throw errors.replayDetected();
  await c.env.DB_PRIVATE.prepare(
    "DELETE FROM ingest_nonces WHERE expires_at < datetime('now')",
  ).run();
  try {
    await c.env.DB_PRIVATE.prepare(
      "INSERT INTO ingest_nonces (nonce, expires_at) VALUES (?, datetime('now', ?))",
    )
      .bind(nonce, `+${NONCE_TTL_SEC} seconds`)
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      throw errors.replayDetected();
    }
    throw e;
  }

  // 3) 签名（覆盖 timestamp.nonce.body；任何不匹配 → signature_invalid）
  const signature = (c.req.header("x-ingest-signature") ?? "").toLowerCase();
  const expected = await hmacHex(secret, `${tsHeader}.${nonce}.${raw}`);
  if (!/^[0-9a-f]{64}$/.test(signature) || !equalHex(expected, signature)) {
    throw errors.signatureInvalid();
  }
  return raw;
}

/** 签名校验通过后再解析 body（格式错 → 400；schema 校验由调用方按端点执行） */
function parseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw errors.badRequest("请求体不是合法 JSON");
  }
}

// POST /internal/ingest/batch —— 批次受理（签名 → 门禁 → 记录；04D：带 observations 时落库+聚合）
internalRoutes.post("/ingest/batch", async (c) => {
  const raw = await verifySignedRequest(c);
  const body = parseJsonBody(raw);
  validateOrThrow(ingestBatchSchema, body);
  const input = body as {
    batch_id: string;
    source_id: string;
    city_code: string;
    object_level: string;
    observed_count?: number;
    observations?: ObservationInput[];
  };

  // 04D 交叉与语义校验（先于门禁与受理，失败不落任何行）
  if (input.observations !== undefined) {
    if (input.observed_count !== input.observations.length) {
      throw errors.validation([
        {
          field: "/observed_count",
          message: `必须与 observations 长度一致（${input.observations.length}）`,
        },
      ]);
    }
    assertObservationSemantics(input.observations, "/observations");
  }

  // 门禁（pending_review/suspended/超范围等一律拒绝，PRD 04A 验收）
  await assertIngestAllowed(c.env, input);

  // 受理记录（同 batch_id 重复提交 → 幂等确认，不重复写入，§11.3）
  try {
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO ingest_batches (batch_id, source_id, city_code, object_level)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(
        input.batch_id,
        input.source_id,
        input.city_code,
        input.object_level,
      )
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      return c.json({ batch_id: input.batch_id, status: "duplicate" }, 202);
    }
    throw e;
  }

  // 04D：批内观测明细落库 + 快照聚合（重复 batch 已在上面短路，不会重写）
  if (input.observations !== undefined) {
    const result = await writeObservations(
      c.env,
      input.source_id,
      input.observations,
    );
    return c.json(
      {
        batch_id: input.batch_id,
        status: "accepted",
        observations_written: result.observations_written,
        snapshots_upserted: result.snapshots_upserted,
      },
      202,
    );
  }
  return c.json({ batch_id: input.batch_id, status: "accepted" }, 202);
});

// POST /internal/jobs/start —— 任务开始（04B / §10.4；过 source-gate 门禁，未 approved 来源起不了任务）
internalRoutes.post("/jobs/start", async (c) => {
  const raw = await verifySignedRequest(c);
  const body = parseJsonBody(raw);
  validateOrThrow(ingestJobStartSchema, body);
  const input = body as {
    job_id: string;
    source_id: string;
    city_code: string;
    object_level: string;
  };

  await assertIngestAllowed(c.env, input);

  try {
    await c.env.DB_PRIVATE.prepare(
      `INSERT INTO ingest_jobs (job_id, source_id, city_code)
       VALUES (?, ?, ?)`,
    )
      .bind(input.job_id, input.source_id, input.city_code)
      .run();
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      return c.json({ job_id: input.job_id, status: "duplicate" }, 202);
    }
    throw e;
  }
  return c.json({ job_id: input.job_id, status: "started" }, 202);
});

// POST /internal/jobs/:id/finish —— 任务完成（04B / §10.4-11；未知 job 404，重复 finish 幂等不改写）
internalRoutes.post("/jobs/:id/finish", async (c) => {
  const raw = await verifySignedRequest(c);
  const body = parseJsonBody(raw);
  validateOrThrow(ingestJobFinishSchema, body);
  const input = body as {
    status: "succeeded" | "failed";
    error_code?: string;
    note?: string;
  };
  const jobId = c.req.param("id");

  const row = await c.env.DB_PRIVATE.prepare(
    `SELECT status, finished_at FROM ingest_jobs WHERE job_id = ?`,
  )
    .bind(jobId)
    .first<{ status: string; finished_at: string | null }>();
  if (!row) throw errors.jobNotFound();
  // 已完成的任务重复 finish：幂等返回当前状态，不改写留痕
  if (row.finished_at !== null) {
    return c.json({ job_id: jobId, status: row.status }, 202);
  }

  // finished_at IS NULL 条件守卫：并发 finish 时只有一个真正写入
  const result = await c.env.DB_PRIVATE.prepare(
    `UPDATE ingest_jobs
        SET status = ?, finished_at = datetime('now'), error_code = ?, note = ?
      WHERE job_id = ? AND finished_at IS NULL`,
  )
    .bind(input.status, input.error_code ?? null, input.note ?? null, jobId)
    .run();
  if (result.meta.changes === 0) {
    const current = await c.env.DB_PRIVATE.prepare(
      `SELECT status FROM ingest_jobs WHERE job_id = ?`,
    )
      .bind(jobId)
      .first<{ status: string }>();
    return c.json(
      { job_id: jobId, status: current?.status ?? input.status },
      202,
    );
  }
  return c.json({ job_id: jobId, status: input.status }, 202);
});

// POST /internal/health/source —— 来源健康上报（04B / §10.4；不设资格门禁：down/degraded 恰恰要能记录）
internalRoutes.post("/health/source", async (c) => {
  const raw = await verifySignedRequest(c);
  const body = parseJsonBody(raw);
  validateOrThrow(sourceHealthSchema, body);
  const input = body as {
    source_id: string;
    status: "ok" | "degraded" | "down";
    latency_ms?: number;
    detail?: string;
  };

  const reportId = crypto.randomUUID();
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO source_health_reports (report_id, source_id, status, latency_ms, detail)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      reportId,
      input.source_id,
      input.status,
      input.latency_ms ?? null,
      input.detail ?? null,
    )
    .run();
  return c.json({ report_id: reportId, status: "recorded" }, 202);
});

// POST /internal/sources/:id/eligibility —— 运行前资格预检（04B 验收二的裁决点）
// 判定完全来自 source-gate（resolveLicense 含惰性过期；带 coverage 走 assertIngestAllowed 四段），
// 端点不写任何自有状态查询（project_memory 红线：connector 复用 source-gate 门禁）。
internalRoutes.post("/sources/:id/eligibility", async (c) => {
  const raw = await verifySignedRequest(c);
  const body = parseJsonBody(raw);
  validateOrThrow(sourceEligibilitySchema, body);
  const input = body as { city_code?: string; object_level?: string };
  const sourceId = c.req.param("id");

  const hasCity = input.city_code !== undefined;
  const hasLevel = input.object_level !== undefined;
  if (hasCity !== hasLevel) {
    throw errors.badRequest("city_code 与 object_level 必须同时提供");
  }

  if (hasCity && hasLevel) {
    // 覆盖范围模式：四段门禁全跑（存在 → 许可 → 覆盖 → 城市状态），失败透传稳定错误码
    await assertIngestAllowed(c.env, {
      source_id: sourceId,
      city_code: input.city_code as string,
      object_level: input.object_level as string,
    });
    const license = await resolveLicense(c.env, sourceId);
    return c.json({
      eligible: true,
      source_id: sourceId,
      status: license?.status ?? "discovered",
      valid_until: license?.valid_until ?? null,
    });
  }

  // 仅 source_id 模式：存在性（404）→ 许可状态（403，惰性过期在 resolveLicense 内处理）
  const source = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id FROM data_sources_public WHERE source_id = ?`,
  )
    .bind(sourceId)
    .first();
  if (!source) throw errors.sourceNotFound();
  const license = await resolveLicense(c.env, sourceId);
  const status = license?.status ?? "discovered";
  if (!(AUTOMATION_ALLOWED_STATUSES as readonly string[]).includes(status)) {
    throw errors.sourceNotApproved(
      `数据源当前状态不允许自动采集（status=${status}）`,
    );
  }
  return c.json({
    eligible: true,
    source_id: sourceId,
    status,
    valid_until: license?.valid_until ?? null,
  });
});
