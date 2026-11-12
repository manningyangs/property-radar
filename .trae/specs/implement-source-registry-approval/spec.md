# TASK-04A 数据源登记与审批系统 Spec

> PRD 任务书 V1.2 · 任务行 1280–1286 · 关联 §5.2 数据源状态机 / §5.3 审核清单 / §5.6 连接器规范 / §9.1 data_sources_public+source_city_coverage / §9.2 admin_roles+audit_logs / §10.4 数据导入 API / §10.5 管理员 API / §11.1 日更流程
> 备份 tag：`pre-v1-p2-task-04a`（指向 d390845，工作区干净）
> 交付范围（用户已确认）：**门禁库 + 管理端审批 API + internal 批次端点（纯后端，无管理 UI——可视化属 TASK-06C）**
> 管理员认证（用户已确认）：**会话 + `admin_roles` 角色校验**（最小 `requireAdmin`，普通用户 403；MFA/RBAC 细化/Cloudflare Access 留 TASK-06A）
> 门禁载体（用户已确认）：**共享门禁库函数 + 最小 `POST /internal/ingest/batch`（HMAC 签名+时间戳+防重放）**，04B connector 复用同一门禁；批次入口只做门禁与受理记录，不解析观测明细（清洗落库属 04E）

## Why

Public 库已有 [data_sources_public](file:///e:/desktop/home_search/db/migrations/public/0001_init.up.sql#L26-L36)（纯公开说明，**无状态列**）与 [source_city_coverage](file:///e:/desktop/home_search/db/migrations/public/0001_init.up.sql#L40-L54)（有 authorization_status），Private 库已有 [admin_roles](file:///e:/desktop/home_search/db/migrations/private/0001_init.up.sql#L199-L208) 与 [audit_logs](file:///e:/desktop/home_search/db/migrations/private/0001_init.up.sql#L213-L227)——但状态机、审批证据、门禁全部缺位：没有任何地方记录"这个来源现在是什么许可状态、依据什么证据、允许到什么范围"；`/admin/*`、`/internal/*` 路由不存在；没有代码阻止 `pending_review` 来源或超范围批次进入管线。04B connector 与 04C 首个数据源都以本任务的门禁为前置。

## What Changes

- **Public 迁移 0002 `source_license_state`**：source_id PK → data_sources_public FK、`status`（§5.2 七态 CHECK，默认 `discovered`）、`valid_until`（授权到期日 YYYY-MM-DD，可空）、`updated_at`。**不 ALTER data_sources_public**（SQLite ADD COLUMN 非幂等，与 0003/0004 同策略用新表）；**审批证据/合同材料不入 Public DB**（§9.1 红线）。
- **Private 迁移 0005**：`source_approvals`（append-only 审批记录：审批人、证据链接/合同编号、许可字段、用途、覆盖范围 JSON、频率、保存期限、到期日、审批后状态、note、created_at）+ `ingest_batches`（批次受理元数据：batch_id PK、source_id、city_code、object_level、received_at）+ `ingest_nonces`（防重放 nonce PK、expires_at）。审批记录只 INSERT，无任何 UPDATE 路径（06C"审批记录不可无痕修改"的存储前提）。
- **门禁库 `apps/api/src/source-gate.ts`**：`resolveLicense()`（读状态 + **惰性过期自动 suspend**：approved_* 且 valid_until < 今天 → 写回 suspended + audit_logs + coverage 行置 suspended）；`assertIngestAllowed()`（依次校验：source 存在 → status ∈ `{approved_open, approved_licensed}` → coverage 行存在且 authorization_status 已批准且 object_level 匹配 → `cities.status ∈ {active, limited}`），任一不过抛稳定错误码。04B connector 复用。
- **管理端 `apps/api/src/routes/admin.ts`**：`requireAdmin` 中间件（requireSession → admin_roles 有效行，否则 403 `admin_required`）；`GET/POST/PATCH /admin/sources`（登记 discovered、元数据编辑，status 不接受 PATCH）；`POST /admin/sources/:id/approve`（必填证据五件套+范围 coverage 数组 → 状态机校验 → 写 approvals + 更新状态 + upsert coverage + 写审计）；`POST /admin/sources/:id/suspend`（reason 必填 → suspended + coverage 全量同步 + 审计）。非法状态转换 → 409。
- **internal 批次 `apps/api/src/routes/internal.ts`**：`POST /internal/ingest/batch`——`X-Ingest-Timestamp`（偏差 ≤300s）+ `X-Ingest-Nonce`（ingest_nonces 防重放）+ `X-Ingest-Signature`（HMAC-SHA256 hex，key=`INGEST_HMAC_SECRET` Secret，签名覆盖 `timestamp.nonce.rawBody`）→ 门禁 `assertIngestAllowed` → 写 ingest_batches → 202。任何关卡失败均 403 稳定错误码；未配置 secret 时端点整体禁用。
- **校验层**：[validation.ts](file:///e:/desktop/home_search/apps/api/src/validation.ts) 白名单扩 `items`（数组元素 schema 递归解释——approve 的 coverage 数组必需）；`schemas.ts` 新增 createSource/patchSource/approveSource/suspendSource/ingestBatch 五 schema。
- **公共展示**：`GET /public/methodology/sources` LEFT JOIN 附 `license_status`、`license_valid_until`（缺行按 `discovered`），为 07B 逐页面来源展示核对铺垫。
- **环境**：`INGEST_HMAC_SECRET` 新增 Secret（本地 dev 按 SESSION_SIGNING_SECRET 既有先例在 wrangler.jsonc 放本地占位值；生产值不入仓库），`.env.example` 只列名称。
- **BREAKING**：无（仅新增表、路由与响应字段）。

## Impact

- Affected specs: 数据源登记与审批（04A）、通用 Connector 框架（04B 消费门禁）、首个官方数据源（04C 消费门禁与批次端点）、数据源管理后台（06C 消费审批/审计）、安全合规（07A/07B）
- Affected code:
  - `db/migrations/public/0002_source_license_state.{up,down}.sql`、`db/migrations/private/0005_source_registry.{up,down}.sql`
  - `packages/migrations/src/index.test.ts`（PUBLIC_TABLES +1、PRIVATE_TABLES +3）
  - `apps/api/src/source-gate.ts`（新）、`routes/admin.ts`（新）、`routes/internal.ts`（新）、`app.ts`（挂路由）、`env.ts`（INGEST_HMAC_SECRET）、`schemas.ts`、`validation.ts`（items 关键字）
  - `apps/api/src/routes/public.ts`（methodology/sources 附状态）
  - api 测试 `admin.test.ts`、`internal.test.ts`（新）
  - `wrangler.jsonc`、`.env.example`
- 无需改动：`apps/web`（管理 UI 属 06C；演示分支不动）、`packages/shared`（SOURCE_STATUSES/AUTOMATION_ALLOWED_STATUSES 已有）

## ADDED Requirements

### Requirement: 数据源许可状态机存储

系统 SHALL 通过 Public 新表 `source_license_state` 维护 §5.2 七态（discovered/pending_review/manual_only/approved_open/approved_licensed/suspended/blocked，CHECK 约束）与 `valid_until` 授权到期日；登记新来源时状态为 `discovered`；状态变更仅允许经 approve/suspend 两个端点（PATCH 不接受 status 字段）。审批证据、合同编号、许可字段/用途/频率/保存期限 SHALL 存 Private 表 `source_approvals`（append-only），任何 API 不提供对既有审批记录的修改或删除。

#### Scenario: 登记即 discovered

- **WHEN** 管理员 POST /admin/sources 登记新来源成功
- **THEN** `source_license_state.status='discovered'`，未配置审批记录

#### Scenario: 状态不能由 PATCH 直改

- **WHEN** PATCH /admin/sources/:id 携带 `status` 字段
- **THEN** 返回 400 `errors.validation`（状态只能走审批/停用端点）

### Requirement: 审批必须附完整证据与范围

`POST /admin/sources/:id/approve` SHALL 要求必填：`status`（approved_open 或 approved_licensed 二选一）、`evidence_ref`（证据链接/合同编号）、`permitted_fields`（≥1 项许可字段）、`permitted_purposes`（≥1 项许可用途）、`frequency`（允许调用频率）、`retention_period`（允许保存期限）、`coverage`（≥1 项 {city_code, object_level, metric_codes≥1} 覆盖范围）、可选 `valid_until` 与 `note`；缺任一必填 → 400 `errors.validation`。成功时 SHALL 一次事务性完成：写 `source_approvals`、更新 `source_license_state`（status/valid_until/updated_at）、按 coverage upsert `source_city_coverage`（authorization_status=审批后状态、last_verified_at=now，city_code 必须存在于 cities，否则 404）、写 `audit_logs`（action=`source.approve`，actor=审批人）。

#### Scenario: 仅勾选已授权不可放行

- **WHEN** approve 请求只带 `status=approved_licensed` 而缺 evidence_ref/字段/用途/频率/期限/coverage 任一
- **THEN** 返回 400，details 指明缺失字段；来源状态保持原样、不产生审批记录

#### Scenario: 覆盖范围落地

- **WHEN** approve 携带 coverage=[{city_code:'3301', object_level:'community', metric_codes:['community_ask_median_unit']}]
- **THEN** `source_city_coverage` 出现/更新对应行且 authorization_status 与来源状态一致，其他既有表结构不变

### Requirement: 状态转换门禁

系统 SHALL 校验状态转换合法性：approve 仅允许从 `discovered`/`pending_review`/`manual_only`/`suspended` → `approved_open`/`approved_licensed`（`blocked` 不可 approve；`approved_*` 状态下重复 approve → 409，授权变更重审必须先走 suspend 显式留痕）；suspend 仅允许 → `suspended`；非法转换返回 409 稳定错误码，不写任何库。

#### Scenario: blocked 来源不可审批

- **WHEN** 对 `blocked` 来源调用 approve
- **THEN** 返回 409，状态与审批记录均不变

#### Scenario: 重新审批须先停用

- **WHEN** 对已 `approved_open` 来源再次调用 approve（授权变更重审）
- **THEN** 返回 409；必须先 suspend（写审计）再 approve

### Requirement: 惰性过期自动 suspend

系统 SHALL 在门禁读取与 `GET /admin/sources` 读取时执行过期判定：status ∈ {approved_open, approved_licensed} 且 `valid_until` 非空且早于今天 → 自动将 status 改为 `suspended`、该来源全部 `source_city_coverage` 行 authorization_status 同步 `suspended`、写 `audit_logs`（action=`source.auto_suspend`，reason=license_expired），并以 suspended 结果返回。

#### Scenario: 授权到期后下一批次被拒

- **WHEN** 某 approved 来源 valid_until 设为昨天，随后携带合法签名的批次请求
- **THEN** 批次被 403 拒绝（`source_not_approved`），且库中该来源 status 已变为 `suspended`、审计留痕

### Requirement: 批次入管线前置门禁

`assertIngestAllowed(env, {source_id, city_code, object_level})` SHALL 依次校验并以稳定错误码拒绝：① source 不存在 → 404 `source_not_found`；② 状态非 `approved_open`/`approved_licensed`（含 pending_review、manual_only、suspended、blocked、discovered、过期自动停用）→ 403 `source_not_approved`；③ `source_city_coverage` 无 (source_id, city_code, object_level) 行、或其 authorization_status 非 approved/approved_open/approved_licensed → 403 `city_coverage_denied`（**拒绝超范围批次**）；④ `cities.status` 非 active/limited → 403 `city_coverage_denied`。门禁函数只读判定（过期副作用除外），供 04B connector 与 internal 批次端点共用。

#### Scenario: 验收一——pending_review 被拒绝

- **WHEN** source 状态为 `pending_review`（即使 coverage 行齐全、签名合法）调用批次入口
- **THEN** 返回 403 `source_not_approved`，未写入 ingest_batches

#### Scenario: 验收二——suspend 后下一批任务不得执行

- **WHEN** approved 来源成功受理一批次后被 suspend，同一来源的下一批次请求（签名合法）
- **THEN** 返回 403 `source_not_approved`，ingest_batches 无新行

#### Scenario: 超范围批次被拒绝

- **WHEN** 批次 city_code 不在该 source 的 coverage（或 object_level 不匹配、或城市 status=requestable）
- **THEN** 返回 403 `city_coverage_denied`

### Requirement: HMAC 签名批次端点

`POST /internal/ingest/batch` SHALL 校验：`INGEST_HMAC_SECRET` 未配置 → 403 `ingest_disabled`（端点整体禁用）；签名/时间戳/nonce 任一缺失或非法 → 403（`signature_invalid` / `stale_timestamp`（偏差 >300s）/ `replay_detected`（nonce 已存在）），验证顺序为 时间戳 → nonce 落库（INSERT OR ABORT，冲突即重放）→ 签名；全部通过后执行门禁，门禁通过写 `ingest_batches` 并返回 202 `{batch_id, status:"accepted"}`。请求体 schema：`batch_id`、`source_id`、`city_code`、`object_level`（city/district/community/listing）、可选 `observed_count`（非负整数）；04A 不解析观测明细。签名验证不得把 secret 写入日志或错误响应。

#### Scenario: 签名与防重放

- **WHEN** 同一 (timestamp, nonce, body) 请求第二次到达，或 body 被篡改（签名不匹配），或时间戳偏差 301 秒
- **THEN** 分别返回 403 `replay_detected` / `signature_invalid` / `stale_timestamp`

#### Scenario: 正常批次受理

- **WHEN** 合法签名 + 门禁通过
- **THEN** 202，ingest_batches 出现 batch_id 对应行（source_id/city_code/object_level 记录正确）

### Requirement: 管理员角色门禁

`/admin/*` 路由 SHALL 经过 `requireAdmin`：未登录（无有效会话）→ 401（复用既有 requireSession 语义，401→登录跳转由前端 api.ts 处理）；已登录但 `admin_roles` 无 `revoked_at IS NULL` 的行 → 403 `admin_required`；非 admin 路由不受影响。普通用户即使直接请求 admin API 也拿不到任何来源数据。

#### Scenario: 普通用户越权

- **WHEN** 普通已登录用户 GET /admin/sources
- **THEN** 返回 403 `admin_required`，响应不含来源列表

### Requirement: 来源停用与审计

`POST /admin/sources/:id/suspend` SHALL 要求 `reason` 必填，成功后：status → `suspended`、该来源全部 coverage 行同步 `suspended`、写 `audit_logs`（action=`source.suspend`，reason 记录）、可选写一条 suspend 的 `source_approvals` 记录不强制——审批记录仅审批动作，停用以 audit_logs 为准。`GET /admin/sources` 返回每来源的元数据、status、valid_until、coverage 行、审批记录数与 `is_expired` 标记（并触发惰性过期处理）。审计查询端点（GET /admin/audit）属 TASK-06C，本任务只写不读。

#### Scenario: 停用即断供

- **WHEN** 对 approved 来源 suspend（reason="授权撤销"）后立即提交同来源批次
- **THEN** 批次 403，audit_logs 有 `source.suspend` 记录含 reason

### Requirement: 公开来源页展示许可状态

`GET /public/methodology/sources` SHALL 在既有字段基础上附 `license_status`（LEFT JOIN source_license_state，缺行 `discovered`）与 `license_valid_until`（可空），不暴露 evidence_ref/审批人/许可字段明细等私有材料。

#### Scenario: 公开响应不含私有审批材料

- **WHEN** 请求该端点
- **THEN** 响应只有公开元数据+状态+到期日，无 evidence_ref、approver 等字段

## MODIFIED Requirements

（无——既有端点仅新增响应字段，向后兼容）

## REMOVED Requirements

（无）
