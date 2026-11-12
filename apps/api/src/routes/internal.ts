// TASK-04A：internal 数据导入端点（PRD 任务行 1285 / §10.4：HMAC 签名、时间戳、nonce 防重放、固定来源 ID 与批次 ID）
// 校验顺序（04A spec）：密钥就绪 → 时间戳（±300s）→ nonce 落库（冲突即重放）→ HMAC 签名 → body schema → 门禁 → 受理。
// 04A 只做门禁与受理记录（ingest_batches），不解析观测明细——清洗/去重落库属 TASK-04E，04B connector 复用同一门禁。
// 签名口径：HMAC-SHA256(INGEST_HMAC_SECRET, `${timestamp}.${nonce}.${rawBody}`) 的小写 hex；
// 任何失败只回稳定 error_code，绝不回显 secret 或内部细节。
import { Hono } from "hono";
import { errors } from "../errors";
import { type AppEnv } from "../env";
import { validateOrThrow } from "../validation";
import { ingestBatchSchema } from "../schemas";
import { assertIngestAllowed } from "../source-gate";

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

// POST /internal/ingest/batch —— 批次受理（签名 → 门禁 → 记录）
internalRoutes.post("/ingest/batch", async (c) => {
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

  // 4) 请求体（签名校验通过后再解析；格式错 → 400）
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw errors.badRequest("请求体不是合法 JSON");
  }
  validateOrThrow(ingestBatchSchema, body);
  const input = body as {
    batch_id: string;
    source_id: string;
    city_code: string;
    object_level: string;
  };

  // 5) 门禁（pending_review/suspended/超范围等一律拒绝，PRD 04A 验收）
  await assertIngestAllowed(c.env, input);

  // 6) 受理记录（同 batch_id 重复提交 → 幂等确认，不重复写入，§11.3）
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
  return c.json({ batch_id: input.batch_id, status: "accepted" }, 202);
});
