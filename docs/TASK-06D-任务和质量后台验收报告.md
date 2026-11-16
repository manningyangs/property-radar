# TASK-06D 任务和质量后台验收报告

- 任务书行 1368–1374：展示任务、来源健康状态、样本和异常，按视觉系统完成桌面端/平板端后台布局
- 验收条款：①每一异常可定位 source/batch/connector version/具体错误码；②重跑有幂等保护；③1440px/1024px 布局清晰、表格小屏横向滚动或卡片视图、不遮挡关键操作
- 交付 commit：`4f9545f`（45 文件，+3133/−101）；CI run `43811670587` success；基线 tag `pre-v1-p2-task-06d`（2e9b151）
- 规格三件套：`.trae/specs/admin-jobs-quality/`（spec / tasks / checklist，本报告随收尾提交勾选）

## 一、拍板决策（AskUserQuestion，用户全选推荐项）

1. 页面范围：`/admin` 总览真实化 + 新建 `/admin/jobs` 采集任务页 + `/admin/quality` 数据质量页（`/admin/users` 前端不在本任务）
2. 数据模型：两个迁移补齐——`ingest_jobs` §8.6 七字段 + `price_observations.batch_id`；internal schema 同步接受可选新字段（向后兼容）
3. 重跑幂等：不新建重跑执行路径（Worker 不跑 connector）；以既有幂等语义写单测实证 + 后台异常详情标注幂等保护说明
4. 质量中心深度：只读聚合三类异常（任务失败 / 来源健康 ≠ ok / 非 valid 观测），每条可定位；§8.7 写操作留后续任务

## 二、交付内容

### R1 数据模型（db/migrations）

- private `0009_job_run_type` … `0015_job_workflow_url` 七对单语句迁移：`ingest_jobs` 加 run_type / records_fetched / records_accepted / records_rejected / communities_covered / connector_version / workflow_url
- public `0005_obs_batch`（batch_id 列）+ `0006_obs_batch_index`（ix_price_obs_batch）
- 偏差修正：spec 原写「一个多语句迁移」，实测违反迁移测试「重复执行幂等」断言，按 0004 先例拆为单语句 + `-- +migrate-idempotent` 指令；`package.json` 五条 db:up/down/apply 链同步（每文件 `|| echo skip` 兜底）
- 旧行新列为 NULL，读取端 null 兜底显示「—」

### R2 internal 扩展（schemas.ts / routes/internal.ts / observations.ts）

- `ingestJobStartSchema` 可选 run_type/connector_version/workflow_url；`ingestJobFinishSchema` 可选四计数；全部向后兼容（04B/04D/04E 既有载荷与测试不受影响）
- `writeObservations` 增 batchId 参数落 `price_observations.batch_id`；**canonicalObservation 不含 batch_id**——observation_id 稳定性与幂等口径不变

### R3/R4/R5 admin API（新文件 routes/admin-ops.ts + admin-users.ts）

- `GET /admin/jobs`：source_id/status/city_code 筛选、q 搜索（LIKE 转义）、sort/order、limit/offset 分页、§8.6 全字段 + source 名称 + 近 7 日 summary（success_rate 分母 0 → null）
- `GET /admin/quality/issues`：kind=job_failed/health/observation 三类聚合合并；统一 issue 形态 + `locator` 定位链（job→job_id/error_code/connector_version/workflow_url；health→report_id/detail/checked_at；observation→observation_id/batch_id/connector_version/quality_status/object_id/stat_date）+ counts；纯只读
- `GET /admin/overview` 增 `ops` 块：jobs_7d、last_update_at、communities_covered、source_issue_count（健康 ≠ ok ∪ 近 7 日 failed 来源，去重）
- 门禁：`adminOpsRoutes.use("*", requireAdminAccess)`（06A 同模式）

### R6/R7 前端（apps/web）

- `lib/api.ts`：AdminJobItem/AdminJobsResult/QualityIssue/QualityIssuesResult/AdminOverviewResult + 三函数
- 新组件 `AdminMfaGate.astro` + `lib/admin-gate.ts`：共享 MFA 门禁状态机，三页复用（sources.astro 保持 06C 原样避免回归）
- `/admin` 重写真实版：状态条（城市选择/覆盖/系统健康）+ 四指标卡 + 近 7 日摘要 + 快捷入口 + 许可分布；`PUBLIC_DEMO_DATA=1` demo 分支保留
- `/admin/jobs`：搜索/筛选/排序/分页表 + 行抽屉（§8.6 全字段、错误码高亮、工作流链接、重跑幂等保护说明）
- `/admin/quality`：三类异常 chips 筛选 + 表 + 抽屉（定位要素逐项 + 幂等与写操作说明）
- AdminSidebar 链接实化；1440/1024 响应式：≤1024px 表格行切卡片视图（media query），无横向溢出

### 修复（浏览器实测中发现）

- Astro scoped 样式编译为 `选择器:where([data-astro-cid])`，JS 动态插入的 `tr/td` 不带该属性 → ≤1024 卡片视图 media 规则不命中（1024 档仍是挤压表格）。jobs/quality 两页样式块改 `<style is:global>`（页面 bundle 隔离，不泄漏他页）后复验生效

## 三、验收结果

### 四门禁（修复后复跑）

| 门禁 | 结果 |
| --- | --- |
| typecheck（api tsc + web astro check） | 0 errors |
| lint（eslint + prettier --check） | 全绿 |
| test（vitest 全量） | api **286 passed**（含 admin-ops.test.ts 新增 17 用例）+ migrations 26 全过 |
| build（astro） | 16 页含 `/admin/jobs` `/admin/quality` |

### 后端单测（admin-ops.test.ts，17 用例）

门禁矩阵（401 / 403 admin_required / 403 mfa_required ×2 端点）、jobs 筛选/搜索/排序/分页/summary/§8.6 全字段、quality 三类聚合与 locator 非空断言（batch_id/connector_version/error_code）、overview ops 四指标、internal 新字段落库与向后兼容、**重跑幂等实证**：同 batch 重提 202 duplicate 不重写、同观测重提行数不变（确定性 ID upsert）、重复 finish 计数与状态不改写。

### 浏览器实测（本地 wrangler dev 8789 + astro dev 4321 + 桩网关 18799；Edge 无头 playwright-core，1440×900 / 1024×768 双档）

| 步骤 | 结果 | 截图 |
| --- | --- | --- |
| OTP 登录链路（request-code→桩日志读码→verify-code→pr_session） | PASS | — |
| MFA TOTP 验证（RFC 6238 口令）→ 会话已验进门禁主区 | PASS | — |
| /admin 总览：状态条 + 四指标卡真实数据（成功率 66.7%、更新时间、覆盖小区 3、来源异常 4） | PASS | `06d-01-admin-overview-1440.jpg` |
| /admin/jobs 列表 10 行（种子任务全字段+旧种子 NULL 兜底） | PASS | `06d-02-jobs-1440.jpg` |
| 筛选 failed=3 行 / 搜索 q 命中单行 / 排序 finished_at asc | PASS | — |
| 任务抽屉：j_06d_sched_fail 全字段 + E_FETCH_TIMEOUT + connector 0.7.2 + 工作流链接 + 幂等保护说明 | PASS | `06d-03-jobs-drawer-1440.jpg` |
| /admin/quality 三类合并 11 条（任务失败/来源健康/观测异常） | PASS | `06d-04-quality-1440.jpg` |
| 异常抽屉定位链：观测异常→batch_id `b_06d_qd_stale` + connector_version + quality_status + 对象/指标/统计日期 | PASS | `06d-05-quality-drawer-1440.jpg` |
| 1024px：jobs 卡片视图生效（tr display:block、无溢出）/ quality / 总览 | PASS | `06d-06..08-*.jpg` |
| 控制台错误 | **0** | — |

截图存证：`docs/evidence/06d-01..08*.jpg`（8 张）。

### 三条验收条款对照

1. **异常可定位 source/batch/connector version/错误码**：R1 batch_id 落库 + R4 locator 统一形态 + 单测非空断言 + 浏览器抽屉逐项实证（06d-03/05）
2. **重跑有幂等保护**：R2 口径不变（canonical 不含 batch_id）+ R8 三条幂等实证单测 + jobs/quality 抽屉「重跑幂等保护」说明（06d-03）
3. **1440/1024 布局清晰、小屏卡片视图、不遮挡关键操作**：双档 8 截图实证；≤1024 行切卡片（修复 scoped 样式后），抽屉为覆盖层不影响表头操作区

## 四、偏差与说明

1. **迁移拆分**：spec 原写 private 0009 / public 0005 各一个多语句迁移，实际按 0004 先例拆为单语句幂等迁移对（private 0009–0015 七对 + public 0005/0006 两对），语义不变；spec 已补注
2. **实测登录方式**：Edge 无头环境访问 `challenges.cloudflare.com` 被断连（本机代理对浏览器与 PowerShell 行为不一致），登录改为真实 API 链路（OTP 桩发码 + verify-code + MFA verify）取会话注入浏览器——认证链路仍全程真实，仅挂件渲染不可达；06C 已实证同链路 UI 全流程
3. **scoped 样式缺陷**：1024 卡片视图首跑未生效，定位 Astro scope 与动态行不匹配后改 `is:global`，同一轮复验通过（见「修复」节）
4. 本地 D1 残留 06D 种子（j_06d_* 任务、b_06d_* 批次、健康报告、test_src_* 等）——仅本地，不影响生产；造数/实测脚本在 `%TEMP%`（pr06d-*），不入库

## 五、残留与移交

- `/admin/users` 前端、§8.7 质量写操作（标记误报/确认异常/重处理批次）、覆盖地图、事件投递后台、系统参数页归各自后续任务
- 生产 D1 迁移将随下次部署执行（新列可空，旧行为 NULL，读取端已兜底）
- 若未来需要宽视口 UI 全流程回归，可为 Playwright 配置可达 CF 挂件的代理，或保留本次「API 会话注入 + UI 实测」双轨方案
