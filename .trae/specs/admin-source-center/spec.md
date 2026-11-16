# TASK-06C 数据源管理（后台页面）Spec

> 任务书 V1.2 任务行 1362–1368 ｜ 基线 tag `pre-v1-p2-task-06c`（20d6d1c）
> 目标：来源、许可状态、覆盖、更新时间、许可到期和启停可视化。
> 验收：未审批不能启用；审批记录不可无痕修改；来源暂停后 connector 任务自动阻止。

## 拍板（AskUserQuestion 2026-11-16，均选推荐项）

1. **页面形态**：新建 `/admin/sources` 页（真实 API）；`/admin` 总览页真实数据改造留给 06D
2. **登录/MFA**：复用 `/login`（OTP）+ 页内 MFA 面板（未绑定→setup 引导；已绑未验→TOTP 输入），全程用 06A 端点
3. **API 缺口**：新增 `GET /admin/sources/:id/approvals`（审批历史）+ `GET /admin/sources` 合并最新 health_status/last_success_at
4. **验收方式**：后端单测 + 04A 既有回归 + 浏览器实测截图存证

## 需求

### R1 API：审批历史查询

`GET /api/v1/admin/sources/:id/approvals`（adminRoutes，统一门禁内）：
- 先 `loadSource`（不存在 404 source_not_found）
- `source_approvals` 按 `created_at DESC, approval_id DESC` 返回 ≤100 条：
  approval_id / action / approver_user_id / evidence_ref / permitted_fields（JSON 解析）/
  permitted_purposes / allowed_cities / frequency / retention_period / valid_until /
  status_after / note / created_at
- 响应 `{ items, count }`；只读端点不写审计（与 GET /admin/sources 一致）
- 表本身 append-only（04A 无 UPDATE/DELETE 路径）——「不可无痕修改」由数据模型保证，
  本端点提供可视化证据

### R2 API：列表合并 health

`GET /admin/sources` 每项新增两字段（批量查询，禁 N+1）：
- `health_status`：该 source 最新一条 `source_health_reports.status`（ok/degraded/down），无记录 `unknown`
- `last_success_at`：该 source 最近一次 `succeeded` 的 `ingest_jobs.finished_at`，无则 null

### R3 前端 API 层

`lib/api.ts` 增：`adminMfaStatus` / `adminMfaSetup` / `adminMfaVerify` /
`adminSourcesList` / `adminSourceCreate` / `adminSourcePatch` / `adminSourceApprove` /
`adminSourceSuspend` / `adminSourceApprovals` / `adminAuditForSource` + 对应类型。
401 自动跳 `/login?next=/admin/sources`（request 既有机制）。

### R4 页面 `/admin/sources.astro`

- 布局：AppShell variant="admin" + 新组件 `AdminSidebar.astro`（10 项导航，active 高亮；
  「数据源中心」→ /admin/sources 可用，其余「即将上线」；「数据运营总览」→ /admin）
- 门禁状态机（client）：`getMe` 401→跳登录；`admin/mfa/status`：
  - 未绑定 → MFA setup 面板（展示 secret + otpauth_uri，输入验证码 verify）
  - 已绑未验 → TOTP 输入面板（verify 后加载数据）
  - 已验 → 加载列表
- 列表（client fetch 渲染，SSG 静态页无服务端取数）：名称/source_id/类型/许可状态徽章/
  到期（is_expired 警示）/覆盖数/last_verified/health/updated_at；搜索 + 状态筛选 chips
- 行点击 → 抽屉：完整元数据 + coverage 表 + **审批历史**（R1，标注 append-only 不可修改）+
  操作审计（GET /admin/audit?resource_type=data_source，client 按 resource_id 过滤）
- 操作（全部 ConfirmDialog 二次确认）：
  - 登记新来源（source_id 小写下划线规则 + name + source_type + 可选元数据）
  - 编辑元数据（PATCH 仅 name/source_type/official_url/data_scope/license_note_url/display_scope）
  - 审批（完整表单对齐 approveSourceSchema：status/evidence_ref/permitted_fields/
    permitted_purposes/frequency/retention_period/coverage 行/valid_until/note）
  - 停用（reason）
- **未审批不能启用**：审批按钮仅对 discovered/pending_review/manual_only/suspended 显示；
  approved_* 状态无「直接启用」路径；暂停后恢复必须重新审批（后端 409 兜底，前端按钮态一致）
- 空态 EmptyState；ApiError 统一 toast；演示构建（PUBLIC_DEMO_DATA=1）不注入本页（真实 API 页）

### R5 测试与验收

- 后端：`admin-sources.test.ts` 新用例——approvals（门禁 401/403/403、404、字段完整、
  倒序、多次审批全保留证明不可无痕修改）；health 合并（seed 报告/jobs 断言最新值与 unknown/null）
- 回归：04A `admin.test.ts`（未审批不进公开/暂停阻止）+ source-gate/ingest 既有断言覆盖验收 1/3
- 前端：`npm run build`（Astro 类型检查 + 静态生成）
- 浏览器实测：wrangler dev（API）+ astro preview（web，PUBLIC_API_BASE 指本地 API），
  browser_use 走查：登录→MFA→列表→审批弹窗→停用→历史→截图；验收报告存证

### 不变量

- §9.4 私库 user-owned 表约束不受影响（source_approvals/audit_logs 非 user-owned）
- 零新迁移、零新错误码（复用 source_not_found/validation_failed/conflict）、零新环境变量
- 门禁复用 requireAdminAccess（会话+角色+MFA），新端点无需显式中间件（adminRoutes 已 use）

## DoD

- [x] R1–R4 实现且四门禁全绿（typecheck/lint/test/build）
- [x] R5 后端新用例 + 回归全过；浏览器实测走查完成并截图
- [x] 中文 commit + push + CI success
- [x] 记忆更新 + `docs/TASK-06C-数据源管理后台验收报告.md`
