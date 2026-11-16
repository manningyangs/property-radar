# TASK-06C 数据源管理后台验收报告

- 任务书行 1362–1368：来源、许可状态、覆盖、更新时间、许可到期和启停可视化
- 验收条款：未审批不能启用；审批记录不可无痕修改；来源暂停后 connector 任务自动阻止
- 交付 commit：`3aa3e98`（14 文件，+2201/−4）；CI run `43803053364` success
- 规格三件套：`.trae/specs/admin-source-center/`（spec / tasks / checklist，本报告随收尾提交勾选）

## 一、拍板决策（AskUserQuestion，用户全选推荐项）

1. 页面形态：新建 `/admin/sources` 数据源中心页（真实 API），`/admin` 总览页留给 06D
2. 登录/MFA：复用 `/login`（邮箱 OTP）+ 页内 MFA 三态面板（未绑定→setup 引导；已绑未验→TOTP 输入；已验→主区）
3. API 缺口：新增 `GET /admin/sources/:id/approvals` 审批历史 + `GET /admin/sources` 合并 `health_status`/`last_success_at`
4. 验收方式：后端单测 + 04A 既有回归 + 浏览器实测截图存证

## 二、交付内容

### R1 审批历史端点（apps/api/src/routes/admin.ts）

- `GET /sources/:id/approvals`：loadSource 404 门禁 → `source_approvals` 按 `created_at DESC, approval_id DESC` 最多 100 条；`permitted_fields_json`/`permitted_purposes_json`/`allowed_cities_json` 解析为数组返回
- 纯只读：不写 audit_logs（与「查看即留痕」的受控明细端点不同，审批历史本身即不可变证据，读取无需再记录）
- 06A 门禁体系自动覆盖：`adminRoutes.use("*", requireAdminAccess)`（会话+角色+MFA），无需逐端点中间件

### R2 health 摘要合并

- `healthBySources(c, ids)`：两查询 `Promise.all`（均 Private 库）——`source_health_reports` 全量取出后 JS 按 `checked_at`/`report_id` 取每来源最新；`ingest_jobs WHERE status='succeeded' AND finished_at IS NOT NULL GROUP BY source_id` 取 `MAX(finished_at)`
- 无记录来源返回 `{health_status:"unknown", last_success_at:null}`；列表与详情统一合并，无 N+1

### R3 前端 API 层（apps/web/src/lib/api.ts）

- 类型：`MfaStatus`/`MfaSetupResult`/`AdminSourceCoverage`/`AdminSourceItem`/`ApprovalRecord`/`AuditLogItem`/`ApproveSourceInput`
- 10 函数：`adminMfaStatus/Setup/Verify`、`adminSourcesList/Create/Patch/Approve/Suspend/Approvals`、`adminAuditForSource`；401 统一跳 `/login?next=/admin/sources`

### R4 页面（apps/web/src/pages/admin/sources.astro，约 700 行）

- MFA 门禁状态机：`getMe → adminMfaStatus →` 三态面板（session_verified 进主区 / confirmed 显示 TOTP 输入 / 未绑定显示「生成 TOTP 密钥」引导）
- 列表：许可状态/到期/覆盖数/健康/最近成功采集/更新时间六要素徽章，过期来源警示，搜索 + 状态筛选 chips
- 抽屉：元数据 + 授权覆盖 + 审批历史（标注 append-only·不可无痕修改）+ 操作审计（按 resource_id 前端过滤）
- 四操作表单：登记（source_id 正则校验）/编辑元数据/审批（字段完整对齐 `approveSourceSchema`）/停用（理由必填），审批与停用走 ConfirmDialog 二次确认
- 「审批启用」按钮仅对 `APPROVE_FROM = {discovered, pending_review, manual_only, suspended}` 显示——验收条款 1 的前端体现
- 新建 `AdminSidebar.astro`（10 项导航 + active），`/admin` 总览页「数据源中心」改为链接互通

### 修复（浏览器实测中发现）

- 卡片类样式 `display:flex` 覆盖 UA 样式表 `[hidden]{display:none}`，导致 MFA 面板验证通过后不隐藏——页面补 `[hidden]{display:none !important}` 兜底

## 三、验收结果

### 四门禁（修复后复跑）

| 门禁 | 结果 |
| --- | --- |
| typecheck（api tsc + web astro check） | 41 files，0 errors |
| lint（eslint + prettier --check） | 全绿 |
| test（vitest 全量 16 文件） | **269 passed**（含 admin-sources.test.ts 新增 7 用例与 04A/04B 全部回归） |
| build（astro） | 14 页含 `/admin/sources` |

### 后端单测（admin-sources.test.ts，7 用例）

门禁矩阵（401 / 403 admin_required / 403 mfa_required）、404 source_not_found、空列表、两次审批历史全保留（suspend 不删记录，验证 append-only）、只读不写审计、health unknown/最新值断言（failed/running 不计入）、approve 响应带 health。

### 浏览器实测（本地 wrangler dev 8789 + astro dev 4321 + 桩网关 18799，全程真实 UI 操作）

| 步骤 | 结果 | 截图 |
| --- | --- | --- |
| OTP 登录（Turnstile 测试挂件勾选→发码→读桩日志→填码） | PASS，跳转 /admin/sources | — |
| MFA setup（点「生成 TOTP 密钥」→ 页面显示密钥与 otpauth URI） | PASS | `06c-02` 前置 |
| MFA verify（按 RFC 6238 计算口令填入→验证并进入→面板隐藏、主区渲染） | PASS | `06c-01-sources-list.jpg` |
| 列表徽章（许可状态/到期/覆盖/健康/最近成功/更新时间，过期来源「已过期+已停用」） | PASS | `06c-01` |
| 抽屉审批历史（test_src_lic 两条：续约+首次，倒序，append-only 标注）+ 操作审计 | PASS | `06c-02-drawer-approvals.jpg` |
| 审批 test_src_disc（表单完整字段→确认弹窗→提交）→ 行变「公开已批准」、覆盖 1 | PASS | `06c-03-approved-disc.jpg` |
| 停用 test_src_lic（理由必填→确认弹窗文案「暂停后采集任务将被自动阻止」→提交）→ 行变「已停用」 | PASS | `06c-04-suspended-lic.jpg` |
| 审批历史新记录落库（04:12:33 公开已批准 + source.approve 审计） | PASS | `06c-05-approval-history.jpg` |

截图存证：`docs/evidence/06c-01..05*.jpg`。

### 三条验收条款对照

1. **未审批不能启用**：前端「审批启用」按钮可见性受 APPROVE_FROM 控制（实测 discovered→审批→公开已批准）；后端 04A 门禁（未审批不进公开链路、approve 必须完整证据）由全量回归覆盖
2. **审批记录不可无痕修改**：`source_approvals` 无任何 UPDATE/DELETE 代码路径（append-only 数据模型保证）；单测实证 suspend 后历史全保留；页面历史标注不可无痕修改
3. **来源暂停后 connector 任务自动阻止**：04A source-gate/ingest 既有回归全绿（269 tests）；确认弹窗文案与停用后徽章同步在浏览器实测实证

## 四、偏差与说明

1. 浏览器实测用 `astro dev` 而非 tasks.md 所写 `astro preview`（dev 支持热更新，修复 hidden bug 后即时复验；页面为 client fetch 渲染，两者行为一致）
2. Turnstile 前端测试键为 22 位 sitekey `1x00000000000000000000AA`，与后端 35 位 secret 串不同；astro dev 需注入 `PUBLIC_TURNSTILE_SITEKEY` 环境变量（仓库无 .env 文件，未新增）
3. MFA 面板验证通过后不隐藏为 06C 页面自身样式缺陷，已在同一 commit 修复并复验（见「修复」节）
4. 审批历史端点读取不写审计：spec 拍板时定义为纯只读证据端点；如需「查看留痕」可后续任务补充

## 五、残留与移交

- 本地 D1（miniflare 持久化）残留 06C 种子与实测状态变更：`test_src_disc` 已批准、`test_src_lic` 已停用、`usr_e2e_admin_06c` 已绑定并验证 MFA——仅本地，不影响生产
- 桩网关脚本/种子 SQL/邮件日志在 `%TEMP%`（pr06c-*），不入库
- `/admin` 总览页与其余管理功能归 TASK-06D
