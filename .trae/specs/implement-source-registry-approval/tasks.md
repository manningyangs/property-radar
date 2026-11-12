# Tasks

- [x] Task 1: 数据库迁移（Public 0002 + Private 0005）
  - [x] SubTask 1.1: `db/migrations/public/0002_source_license_state.up.sql`/`down.sql`——`source_license_state`（source_id PK→data_sources_public FK、status 七态 CHECK 默认 discovered、valid_until 可空 CHECK 日期形态、updated_at；IF NOT EXISTS/DROP IF EXISTS 幂等）
  - [x] SubTask 1.2: `db/migrations/private/0005_source_registry.up.sql`/`down.sql`——`source_approvals`（approval_id PK、source_id 跨库无外键、action/approver_user_id→users、evidence_ref、permitted_fields_json、permitted_purposes_json、allowed_cities_json、frequency、retention_period、valid_until、status_after、note、created_at，均 NOT NULL 除可选项）、`ingest_batches`（batch_id PK、source_id、city_code、object_level、received_at）、`ingest_nonces`（nonce PK、expires_at + 过期索引）
  - [x] SubTask 1.3: `packages/migrations/src/index.test.ts`——PUBLIC_TABLES +1（source_license_state）、PRIVATE_TABLES +3；断言：up 重复执行幂等、down 干净、status/authorization_status CHECK 生效、approvals 与 users FK 级联、nonce 主键冲突报错
- [x] Task 2: 门禁库 `apps/api/src/source-gate.ts`
  - [x] SubTask 2.1: `resolveLicense(env, sourceId)`——读 `source_license_state`（缺行=discovered）；approved_* 且 valid_until<今天 → 惰性 UPDATE status='suspended' + coverage 全量同步 + audit_logs(action=source.auto_suspend, reason=license_expired)，返回 suspended
  - [x] SubTask 2.2: `assertIngestAllowed(env, {source_id, city_code, object_level})`——四段校验（404 source_not_found → 403 source_not_approved → 403 city_coverage_denied（coverage 行/object_level/authorization_status）→ 403 city_coverage_denied（cities.status 非 active/limited））；批准覆盖集合常量 `['approved','approved_open','approved_licensed']`；过期副作用在此触发
- [x] Task 3: 校验层与 schemas
  - [x] SubTask 3.1: `validation.ts` 白名单扩 `items`（数组类型递归 collect 元素 schema；未知关键字仍抛错）+ 对应解释器单测（items 嵌套 properties 通过、非法元素被收集）
  - [x] SubTask 3.2: `schemas.ts` 新增 `createSourceSchema`（source_id `^[a-z][a-z0-9_]{2,63}$`、name/source_type 必填，official_url/data_scope/license_note_url/display_scope 可选）、`patchSourceSchema`（不含 status；additionalProperties:false）、`approveSourceSchema`（status 枚举 approved_open|approved_licensed、evidence_ref minLength、permitted_fields/permitted_purposes ≥1 项、frequency/retention_period 必填、coverage ≥1 项含 city_code/object_level 枚举/metric_codes ≥1、valid_until 日期或 null、note 可选）、`suspendSourceSchema`（reason minLength 1）、`ingestBatchSchema`（batch_id/source_id/city_code、object_level 枚举、observed_count ≥0 整数可选）
- [x] Task 4: 管理端路由 `apps/api/src/routes/admin.ts` + 挂载
  - [x] SubTask 4.1: `requireAdmin` 中间件——requireSession 后查 `admin_roles`（user_id 且 revoked_at IS NULL），无 → 403 `admin_required`（未登录由 requireSession 401）
  - [x] SubTask 4.2: `GET /admin/sources`——JOIN data_sources_public+source_license_state+coverage 聚合+审批记录数，触发惰性过期；`POST /admin/sources`——登记+插 source_license_state(discovered)，重复 source_id → 409；`PATCH /admin/sources/:id`——仅元数据（带 status → 400；不存在 → 404）
  - [x] SubTask 4.3: `POST /admin/sources/:id/approve`——schema 校验 → 状态机（非法 → 409）→ coverage city_code 跨库查 cities（无 → 404）→ 写 source_approvals + 更新 source_license_state + upsert source_city_coverage + 写 audit_logs(action=source.approve) → 200 返回来源详情
  - [x] SubTask 4.4: `POST /admin/sources/:id/suspend`——reason 必填 → status→suspended + coverage 同步 + audit_logs(action=source.suspend) → 200；`app.ts` 挂载 admin 路由；`env.ts` 无需改动
- [x] Task 5: internal 批次端点 `apps/api/src/routes/internal.ts`
  - [x] SubTask 5.1: HMAC 校验链——INGEST_HMAC_SECRET 缺失 → 403 ingest_disabled；时间戳（unix 秒，偏差>300s → 403 stale_timestamp）；nonce INSERT 进 ingest_nonces（冲突 → 403 replay_detected，成功行 expires_at=ts+3600 可清理）；签名 `HMAC-SHA256(secret, `${ts}.${nonce}.${rawBody}`)`.hex 用 timingSafeEqual 比对（不匹配 → 403 signature_invalid）；secret 不入日志
  - [x] SubTask 5.2: 门禁与受理——`assertIngestAllowed` 通过后 INSERT ingest_batches → 202 `{batch_id, status:'accepted'}`；`app.ts` 挂载；`wrangler.jsonc` 本地占位 var + `.env.example` 增列 `INGEST_HMAC_SECRET`（仅名称与说明，无真实值）
- [x] Task 6: 公开来源页状态字段
  - [x] SubTask 6.1: `routes/public.ts` `/methodology/sources` LEFT JOIN source_license_state，附 `license_status`（缺行 discovered）与 `license_valid_until`；不含任何审批私有字段
- [x] Task 7: API 测试（admin.test.ts / internal.test.ts / 门禁）
  - [x] SubTask 7.1: 验收一——pending_review + 合法签名 → 403 source_not_approved、无批次行；验收二——approved 批次 202 → suspend → 下一批 403 且无新批次行
  - [x] SubTask 7.2: 超范围——缺 coverage 行/object_level 不符/城市非 active/limited → 403 city_coverage_denied；未知 source → 404；过期 valid_until → 403 且库中状态已 auto suspend + 有审计
  - [x] SubTask 7.3: 签名链——错签名/时间戳偏差/重放 nonce/缺 secret 四态 403；正常批次 202 且 ingest_batches 行正确
  - [x] SubTask 7.4: 管理端——未登录 401、普通用户 403 admin_required、approve 缺证据字段 400（状态不变）、approve 成功四写（approvals+state+coverage+audit）、blocked→approve 409、approved 重复 approve 409、suspend 后 coverage 同步、PATCH 带 status 400、未知来源 404
  - [x] SubTask 7.5: 公开端点只出公开字段；既有测试全绿（public/me/migrations/shared）
- [x] Task 8: 四门禁与浏览器验收
  - [x] SubTask 8.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿
  - [x] SubTask 8.2: 浏览器回归（真实模式，本地 private D1 直插会话）：首页/登录/watch/rules 既有流程无回归、401→login 跳转正常；演示模式（4322 + PUBLIC_DEMO_DATA=1）行为与 01B 一致；管理 UI 不属本任务（06C），审批验收由 API 测试兜底；node fetch 冒烟 `/public/methodology/sources` 含新字段
- [x] Task 9: 提交与 CI
  - [x] SubTask 9.1: 中文 commit `TASK-04A: …`（UTF-8 临时文件）→ push → 盯 CI 至绿
  - [x] SubTask 9.2: §12.0 收尾报告（改动摘要/文件/测试/风险/回滚）→ checklist 勾选入库 → 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 1] 独立先行（Task 2/4 都依赖新表）
- [Task 2] depends on [Task 1]
- [Task 3] 独立（可与 Task 1/2 并行）
- [Task 4] depends on [Task 1, 2, 3]
- [Task 5] depends on [Task 1, 2, 3]
- [Task 6] depends on [Task 1]（独立小改）
- [Task 7] depends on [Task 4, 5, 6]
- [Task 8] depends on [Task 7]
- [Task 9] depends on [Task 8]
