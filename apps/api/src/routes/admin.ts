// TASK-04A：管理端数据源 API（PRD 任务行 1284–1286 / §10.5 / §5.2 状态机 / §5.3 审核清单）
// 认证：requireAdminAccess 统一门禁（会话 + admin_roles + MFA，TASK-06A）。
// 设计要点：
//   - 状态只能经 approve/suspend 变更（PATCH 不含 status）；非法状态转换 409，不写库；
//   - 审批记录（证据/字段/用途/范围/频率/保存期限/审批人）只 INSERT，append-only；
//   - approve 的 coverage 即最新授权范围：payload 行 upsert 为已批准，source 既有但不在本次范围的行降为 suspended；
//   - 过期授权由 source-gate.resolveLicense 惰性自动 suspend（GET 列表同样触发）；
//   - 所有状态变更写 audit_logs（查询端点 GET /admin/audit 属 TASK-06A，见 routes/admin-auth.ts）。
import { Hono, type Context } from "hono";
import { requireAdminAccess } from "../auth";
import { errors } from "../errors";
import { type AppEnv } from "../env";
import { readJsonBody, validateOrThrow } from "../validation";
import {
  approveSourceSchema,
  createObservationSchema,
  createSourceSchema,
  patchSourceSchema,
  suspendSourceSchema,
} from "../schemas";
import { adminLicenseOf } from "../source-gate";
import { cleanObservations } from "../cleaning";
import { logError } from "../log";
import {
  OBJECT_TYPE,
  writeObservations,
  type ObservationInput,
} from "../observations";
import { evaluateRulesForObjects } from "../rules-engine";

export const adminRoutes = new Hono<AppEnv>();

// TASK-06A：/admin/* 统一门禁（会话 401 → 角色 403 admin_required → MFA 403 mfa_required；
// bootstrap 与 mfa setup/verify/status 豁免规则见 auth.requireAdminAccess）
adminRoutes.use("*", requireAdminAccess);

/** 允许直接审批为 approved_* 的来源状态（blocked 必须显式解除后才可审批） */
const APPROVE_FROM = new Set([
  "discovered",
  "pending_review",
  "manual_only",
  "suspended",
]);

interface SourceRow {
  source_id: string;
  name: string;
  source_type: string;
  official_url: string | null;
  data_scope: string | null;
  license_note_url: string | null;
  display_scope: string | null;
  updated_at: string;
  last_verified_at: string | null;
}

interface CoverageRow {
  source_id: string;
  city_code: string;
  object_level: string;
  metric_codes_json: string;
  authorization_status: string;
  last_verified_at: string | null;
}

async function jsonBody(c: Context<AppEnv>): Promise<unknown> {
  return readJsonBody(c.req.header("content-type"), () => c.req.text());
}

/** 加载来源公开元数据（不存在含他人来源一律 404，不区分） */
async function loadSource(
  c: Context<AppEnv>,
  sourceId: string,
): Promise<SourceRow> {
  const row = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id, name, source_type, official_url, data_scope,
            license_note_url, display_scope, updated_at, last_verified_at
     FROM data_sources_public WHERE source_id = ?`,
  )
    .bind(sourceId)
    .first<SourceRow>();
  if (!row) throw errors.sourceNotFound();
  return row;
}

/** 该 source 的全部覆盖行 */
async function coverageOf(
  c: Context<AppEnv>,
  sourceId: string,
): Promise<CoverageRow[]> {
  const res = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id, city_code, object_level, metric_codes_json,
            authorization_status, last_verified_at
     FROM source_city_coverage WHERE source_id = ? ORDER BY city_code, object_level`,
  )
    .bind(sourceId)
    .all<CoverageRow>();
  return res.results;
}

/** 审批记录数（append-only 计数，供后台列表展示） */
async function approvalCount(
  c: Context<AppEnv>,
  sourceId: string,
): Promise<number> {
  const row = await c.env.DB_PRIVATE.prepare(
    "SELECT COUNT(*) AS n FROM source_approvals WHERE source_id = ?",
  )
    .bind(sourceId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 单来源完整响应：元数据 + 许可状态（含惰性过期）+ 覆盖 + 审批计数 */
async function sourceItem(c: Context<AppEnv>, sourceId: string) {
  const source = await loadSource(c, sourceId);
  const license = await adminLicenseOf(c.env, sourceId);
  return {
    ...source,
    status: license.status,
    valid_until: license.valid_until,
    is_expired:
      license.valid_until !== null &&
      license.valid_until < new Date().toISOString().slice(0, 10),
    coverage: await coverageOf(c, sourceId),
    approval_count: await approvalCount(c, sourceId),
  };
}

// GET /admin/sources —— 来源清单（触发惰性过期；4+1 条批量查询，禁止逐来源 N+1）
adminRoutes.get("/sources", async (c) => {
  const list = await c.env.DB_PUBLIC.prepare(
    `SELECT source_id, name, source_type, official_url, data_scope,
            license_note_url, display_scope, updated_at, last_verified_at
     FROM data_sources_public ORDER BY name LIMIT 100`,
  ).all<SourceRow>();
  const ids = list.results.map((r) => r.source_id);
  if (ids.length === 0) return c.json({ items: [], count: 0 });

  const marks = ids.map(() => "?").join(", ");
  const [licRes, covRes, apprRes] = await Promise.all([
    c.env.DB_PUBLIC.prepare(
      `SELECT source_id, status, valid_until FROM source_license_state
       WHERE source_id IN (${marks})`,
    )
      .bind(...ids)
      .all<{ source_id: string; status: string; valid_until: string | null }>(),
    c.env.DB_PUBLIC.prepare(
      `SELECT source_id, city_code, object_level, metric_codes_json,
              authorization_status, last_verified_at
       FROM source_city_coverage WHERE source_id IN (${marks})
       ORDER BY city_code, object_level`,
    )
      .bind(...ids)
      .all<CoverageRow>(),
    c.env.DB_PRIVATE.prepare(
      `SELECT source_id, COUNT(*) AS n FROM source_approvals
       WHERE source_id IN (${marks}) GROUP BY source_id`,
    )
      .bind(...ids)
      .all<{ source_id: string; n: number }>(),
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const licBy = new Map(licRes.results.map((r) => [r.source_id, r]));
  const covBy = new Map<string, CoverageRow[]>();
  for (const row of covRes.results) {
    const arr = covBy.get(row.source_id) ?? [];
    arr.push(row);
    covBy.set(row.source_id, arr);
  }
  const apprBy = new Map(apprRes.results.map((r) => [r.source_id, r.n]));

  // 惰性过期：命中过期的来源逐个走 resolveLicense（写回 suspended + 审计）
  const items = [];
  for (const source of list.results) {
    const lic = licBy.get(source.source_id);
    let status = lic?.status ?? "discovered";
    const validUntil = lic?.valid_until ?? null;
    const expired =
      (status === "approved_open" || status === "approved_licensed") &&
      validUntil !== null &&
      validUntil < today;
    if (expired) {
      const after = await adminLicenseOf(c.env, source.source_id);
      status = after.status;
    }
    items.push({
      ...source,
      status,
      valid_until: validUntil,
      is_expired: validUntil !== null && validUntil < today,
      coverage: covBy.get(source.source_id) ?? [],
      approval_count: apprBy.get(source.source_id) ?? 0,
    });
  }
  return c.json({ items, count: items.length });
});

// POST /admin/sources —— 登记（一律落 discovered，状态只能走审批端点）
adminRoutes.post("/sources", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(createSourceSchema, body);
  const input = body as Record<string, string | undefined>;

  const dup = await c.env.DB_PUBLIC.prepare(
    "SELECT source_id FROM data_sources_public WHERE source_id = ?",
  )
    .bind(input.source_id)
    .first();
  if (dup) throw errors.conflict("该 source_id 已存在");

  const cols = ["source_id", "name", "source_type"];
  const vals: Array<string | null> = [
    input.source_id ?? null,
    input.name ?? null,
    input.source_type ?? null,
  ];
  for (const key of [
    "official_url",
    "data_scope",
    "license_note_url",
    "display_scope",
  ] as const) {
    if (input[key] !== undefined) {
      cols.push(key);
      vals.push(input[key] ?? null);
    }
  }
  await c.env.DB_PUBLIC.batch([
    c.env.DB_PUBLIC.prepare(
      `INSERT INTO data_sources_public (${cols.join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})`,
    ).bind(...vals),
    c.env.DB_PUBLIC.prepare(
      "INSERT INTO source_license_state (source_id) VALUES (?)",
    ).bind(input.source_id),
  ]);
  // TASK-06A：登记属管理员敏感操作（spec R5 补 04A 漏写）
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, ?, 'admin', 'source.create', 'data_source', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get("userId"),
      input.source_id,
      `${input.name} (${input.source_type})`,
    )
    .run();
  return c.json({ source: await sourceItem(c, input.source_id!) }, 201);
});

// PATCH /admin/sources/:id —— 仅元数据（status 走审批/停用端点，出现在 body 即 400）
adminRoutes.patch("/sources/:id", async (c) => {
  const sourceId = c.req.param("id");
  await loadSource(c, sourceId);
  const body = await jsonBody(c);
  validateOrThrow(patchSourceSchema, body);
  const input = body as Record<string, string | null>;
  const keys = Object.keys(input) as Array<keyof typeof input>;
  if (keys.length === 0)
    throw errors.validation([{ field: "/", message: "至少修改一个字段" }]);
  const setSql = keys.map((k) => `${k} = ?`).join(", ");
  await c.env.DB_PUBLIC.prepare(
    `UPDATE data_sources_public SET ${setSql}, updated_at = datetime('now')
     WHERE source_id = ?`,
  )
    .bind(...keys.map((k) => input[k]), sourceId)
    .run();
  // TASK-06A：元数据修改属管理员敏感操作（spec R5 补 04A 漏写；reason 记改动字段集）
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, ?, 'admin', 'source.update', 'data_source', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get("userId"),
      sourceId,
      `fields=${keys.join(",")}`,
    )
    .run();
  return c.json({ source: await sourceItem(c, sourceId) });
});

// POST /admin/sources/:id/approve —— 审批（必附证据、字段、用途、频率、保存期限与覆盖范围）
adminRoutes.post("/sources/:id/approve", async (c) => {
  const sourceId = c.req.param("id");
  await loadSource(c, sourceId);
  const body = await jsonBody(c);
  validateOrThrow(approveSourceSchema, body);
  const input = body as {
    status: "approved_open" | "approved_licensed";
    evidence_ref: string;
    permitted_fields: string[];
    permitted_purposes: string[];
    frequency: string;
    retention_period: string;
    coverage: Array<{
      city_code: string;
      object_level: string;
      metric_codes: string[];
    }>;
    valid_until?: string | null;
    note?: string;
  };

  // 状态机：非法转换 409（blocked / 重复 approve 须先停用留痕）
  const license = await adminLicenseOf(c.env, sourceId);
  if (!APPROVE_FROM.has(license.status)) {
    throw errors.conflict(
      `当前状态 ${license.status} 不允许审批为 approved（须先停用或处于待审状态）`,
    );
  }

  // 覆盖范围中的城市必须存在（跨库校验，先于任何写入）
  for (const cov of input.coverage) {
    const hit = await c.env.DB_PUBLIC.prepare(
      "SELECT city_code FROM cities WHERE city_code = ?",
    )
      .bind(cov.city_code)
      .first();
    if (!hit) throw errors.notFound(`城市 ${cov.city_code} 不存在`);
  }

  // Public 侧：状态 + 覆盖 upsert（不在本次审批范围的既有行降为 suspended）
  const publicStmts = [
    // 状态 upsert（无 license 行的历史来源补建行，避免 UPDATE 空转）
    c.env.DB_PUBLIC.prepare(
      `INSERT INTO source_license_state (source_id, status, valid_until, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (source_id) DO UPDATE SET
         status = excluded.status,
         valid_until = excluded.valid_until,
         updated_at = excluded.updated_at`,
    ).bind(sourceId, input.status, input.valid_until ?? null),
  ];
  const payloadKeys = new Set(
    input.coverage.map((v) => `${v.city_code}|${v.object_level}`),
  );
  for (const cov of input.coverage) {
    publicStmts.push(
      c.env.DB_PUBLIC.prepare(
        `INSERT INTO source_city_coverage
           (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (source_id, city_code, object_level) DO UPDATE SET
           metric_codes_json = excluded.metric_codes_json,
           authorization_status = excluded.authorization_status,
           last_verified_at = excluded.last_verified_at`,
      ).bind(
        sourceId,
        cov.city_code,
        cov.object_level,
        JSON.stringify(cov.metric_codes),
        input.status,
      ),
    );
  }
  for (const existing of await coverageOf(c, sourceId)) {
    if (!payloadKeys.has(`${existing.city_code}|${existing.object_level}`)) {
      publicStmts.push(
        c.env.DB_PUBLIC.prepare(
          `UPDATE source_city_coverage
             SET authorization_status = 'suspended', last_verified_at = datetime('now')
           WHERE source_id = ? AND city_code = ? AND object_level = ?`,
        ).bind(sourceId, existing.city_code, existing.object_level),
      );
    }
  }
  await c.env.DB_PUBLIC.batch(publicStmts);

  // Private 侧：审批记录（append-only）+ 审计
  await c.env.DB_PRIVATE.batch([
    c.env.DB_PRIVATE.prepare(
      `INSERT INTO source_approvals
         (approval_id, source_id, action, approver_user_id, evidence_ref,
          permitted_fields_json, permitted_purposes_json, allowed_cities_json,
          frequency, retention_period, valid_until, status_after, note)
       VALUES (?, ?, 'approve', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      sourceId,
      c.get("userId"),
      input.evidence_ref,
      JSON.stringify(input.permitted_fields),
      JSON.stringify(input.permitted_purposes),
      JSON.stringify(input.coverage),
      input.frequency,
      input.retention_period,
      input.valid_until ?? null,
      input.status,
      input.note ?? null,
    ),
    c.env.DB_PRIVATE.prepare(
      `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
       VALUES (?, ?, 'admin', 'source.approve', 'data_source', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      c.get("userId"),
      sourceId,
      input.note ?? `status=${input.status}`,
    ),
  ]);
  return c.json({ source: await sourceItem(c, sourceId) });
});

// POST /admin/sources/:id/suspend —— 停用（coverage 全量同步 + 审计；恢复须重新审批）
adminRoutes.post("/sources/:id/suspend", async (c) => {
  const sourceId = c.req.param("id");
  await loadSource(c, sourceId);
  const body = await jsonBody(c);
  validateOrThrow(suspendSourceSchema, body);
  const input = body as { reason: string };

  const license = await adminLicenseOf(c.env, sourceId);
  const fromStatus = license.status;

  await c.env.DB_PUBLIC.batch([
    c.env.DB_PUBLIC.prepare(
      `INSERT INTO source_license_state (source_id, status, updated_at)
       VALUES (?, 'suspended', datetime('now'))
       ON CONFLICT (source_id) DO UPDATE SET
         status = 'suspended', updated_at = datetime('now')`,
    ).bind(sourceId),
    c.env.DB_PUBLIC.prepare(
      `UPDATE source_city_coverage
         SET authorization_status = 'suspended', last_verified_at = datetime('now')
       WHERE source_id = ? AND authorization_status <> 'suspended'`,
    ).bind(sourceId),
  ]);
  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, ?, 'admin', 'source.suspend', 'data_source', ?, ?)`,
  )
    .bind(crypto.randomUUID(), c.get("userId"), sourceId, input.reason)
    .run();

  return c.json({
    source: await sourceItem(c, sourceId),
    previous_status: fromStatus,
  });
});

// POST /admin/observations —— TASK-04D 手工补录单条观测（spec R2：admin 会话+角色门禁已由上方中间件保证；
// body = source_id + 单条观测，复用 observations 模块落明细并重算该组快照；每条写 audit_logs 可追溯）
adminRoutes.post("/observations", async (c) => {
  const body = await jsonBody(c);
  validateOrThrow(createObservationSchema, body);
  const input = body as ObservationInput & { source_id: string };

  // 来源必须已登记（price_observations 外键；未登记一律 404，不区分）
  const source = await c.env.DB_PUBLIC.prepare(
    "SELECT source_id FROM data_sources_public WHERE source_id = ?",
  )
    .bind(input.source_id)
    .first();
  if (!source) throw errors.sourceNotFound();

  // 04E 清洗前置（先于任何 DB 写；400 时零行，spec R1；prefix "" → details 字段路径 /key）
  const clean = await cleanObservations(
    [input],
    new Date(),
    input.source_id,
    "",
  );
  const result = await writeObservations(c.env, input.source_id, clean.cleaned);

  // TASK-05A：补录观测同步评估规则（与 internal 批次同一条引擎路径；
  // 评估失败仅记日志，不影响补录与审计）
  if (result.snapshots_upserted > 0) {
    try {
      await evaluateRulesForObjects(
        c.env,
        [{ object_type: OBJECT_TYPE, object_id: input.object_id }],
        new Date(),
      );
    } catch (err) {
      logError({
        request_id: c.get("requestId") ?? "rules-evaluate",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await c.env.DB_PRIVATE.prepare(
    `INSERT INTO audit_logs (audit_id, actor_user_id, actor_role, action, resource_type, resource_id, reason)
     VALUES (?, ?, 'admin', 'observation.create', 'price_observation', ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      c.get("userId"),
      result.observation_ids[0],
      `source_id=${input.source_id}; price_type=${input.price_type}; stat_date=${input.stat_date}`,
    )
    .run();

  return c.json(
    {
      observation_id: result.observation_ids[0],
      observations_written: result.observations_written,
      snapshots_upserted: result.snapshots_upserted,
      duplicates_dropped: clean.duplicates_dropped,
      stale_count: clean.stale_count,
    },
    201,
  );
});
