# TASK-06D 任务和质量后台 — Spec

> 任务书 V1.2 任务行 1368–1374 ｜ 基线 tag `pre-v1-p2-task-06d`（2e9b151）
> 目标：展示任务、来源健康状态、样本和异常，并按视觉系统完成桌面端/平板端后台布局。

## 拍板决策（AskUserQuestion，全选推荐项）

1. **页面范围**：`/admin` 总览页真实化（四指标卡+顶部状态条）+ 新建 `/admin/jobs` 采集任务页 + `/admin/quality` 数据质量页；`/admin/users` 前端不在本任务
2. **数据模型**：两个迁移补齐——private 0009 `ingest_jobs` 加 run_type/records_fetched/records_accepted/records_rejected/communities_covered/connector_version/workflow_url；public 0005 `price_observations` 加 batch_id；internal schema 同步接受可选新字段（向后兼容）
3. **重跑幂等**：Worker 不执行 Python connector，不新建重跑路径；以既有幂等（同 batch_id 重提 202 duplicate、finish 幂等不改写、observation 确定性 ID upsert 不重复快照）写单测实证，后台异常详情标注幂等保护说明
4. **质量中心深度**：只读聚合（failed jobs + 非 valid 观测 + down/degraded 健康三类异常，每条可定位 source/batch/connector_version/error_code）；§8.7 标记误报/确认异常/重处理批次等写操作留后续任务

## R1 数据模型补齐（db/migrations）

- private `0009_jobs_detail.up.sql`：`ALTER TABLE ingest_jobs ADD COLUMN`（run_type TEXT、records_fetched INTEGER、records_accepted INTEGER、records_rejected INTEGER、communities_covered INTEGER、connector_version TEXT、workflow_url TEXT）；down 逐列 DROP
- public `0005_obs_batch.up.sql`：`ALTER TABLE price_observations ADD COLUMN batch_id TEXT` + 索引 `ix_price_obs_batch (batch_id)`；down DROP
- D1 迁移随 CI/部署执行；旧行新列为 NULL，读取端以 null 兜底

> **收尾偏差补注（实测后修正）**：本段原写「0009_jobs_detail 一个多语句迁移 + public 0005 带索引」——多语句合一文件违反迁移测试「重复执行幂等」断言，已按 0004 先例改为**每列一个单语句迁移 + `-- +migrate-idempotent` 指令**：private `0009_job_run_type`…`0015_job_workflow_url` 七对，public `0005_obs_batch`（列）+`0006_obs_batch_index`（索引）两对；`package.json` db 链同步。语义与验收不变（迁移测试 26 全绿）。

## R2 internal 端点扩展（routes/internal.ts + schemas.ts）

- `ingestJobStartSchema`：可选 `run_type`（enum scheduled/manual/retry）、`connector_version`（≤64）、`workflow_url`（≤500）；jobs/start 落库
- `ingestJobFinishSchema`：可选 `records_fetched/records_accepted/records_rejected/communities_covered`（整数 ≥0）；jobs/finish 首次完成时落库（重复 finish 幂等不改写，既有语义不变）
- `ingestBatchSchema` 不变（batch_id 已有）；`writeObservations` 增 batchId 参数 → observations INSERT/UPDATE 落 `batch_id`；**canonicalObservation 不含 batch_id**（observation_id 稳定性与幂等口径不变，重跑同观测仅更新 batch_id/collected_at）
- 兼容性：全部新字段可选，04B/04D/04E 既有测试与 Python collector 现有载荷不受影响

## R3 GET /admin/jobs（新文件 routes/admin-ops.ts）

- 门禁：`adminOpsRoutes.use("*", requireAdminAccess)`（与 06A/06B 同模式）
- 参数：`source_id`/`status`（running|succeeded|failed）/`city_code` 精确筛选、`q`（job_id/source_id LIKE 转义）、`sort`（started_at|finished_at，默认 started_at）、`order`（asc|desc 默认 desc）、`limit`（默认 20，≤100）/`offset`——搜索/筛选/排序/分页齐备
- 响应 item：§8.6 全字段（job_id、source_id、city_code、run_type、status、started_at、finished_at、error_code、note、records_*、communities_covered、connector_version、workflow_url）+ source 名称
- 附 `summary`：近 7 日 succeeded/failed/running 计数与 success_rate（分母 0 → null）

## R4 GET /admin/quality/issues（同文件，只读聚合）

- `kind` 筛选：`job_failed`（ingest_jobs status=failed）/ `health`（每来源最新健康报告 ≠ ok）/ `observation`（price_observations quality_status ∈ low_sample|stale|outlier|rejected）；缺省三类合并
- 每条 issue 统一形态：`issue_kind`、`source_id`、`source_name`、`locator`（可定位要素集：job→job_id/error_code/connector_version/workflow_url；health→report_id/detail/checked_at；observation→observation_id/batch_id/connector_version/quality_status/object_id/stat_date）、`occurred_at`、`note`
- 分页 limit/offset（每类各取后 JS 合并排序截断，limit≤100）；`counts` 返回三类总数
- 纯只读：不写 audit（与 06C 审批历史同口径——聚合视图非受控明细）

## R5 GET /admin/overview 扩展（routes/admin-users.ts，四指标卡数据源）

- 新增 `ops` 块：
  - `jobs_7d`：近 7 日 succeeded/failed/running + success_rate（任务成功率）
  - `last_update_at`：MAX(price_snapshots.collected_at)（数据更新时间，无快照 → null）
  - `communities_covered`：COUNT(DISTINCT object_id) WHERE quality_status='valid'（已覆盖小区数）
  - `source_issue_count`：健康 ≠ ok 来源数 ∪ 近 7 日有 failed 任务来源数（去重）（来源异常数）
- 既有字段与 06B 测试语义不动，只增不改

## R6 前端 API 层（apps/web/src/lib/api.ts）

- 类型：`AdminJobItem`/`AdminJobsResult`/`QualityIssue`/`QualityIssuesResult`/`AdminOverviewResult`
- 函数：`adminOverview()`、`adminJobsList(params)`、`adminQualityIssues(params)`；401 跳登录沿用 request 统一逻辑

## R7 前端页面（apps/web）

- `src/lib/admin-gate.ts`：共享 MFA 门禁状态机（getMe → adminMfaStatus → 三态：未绑定 setup / 已绑 verify / 已验 onPass），三个新页复用；sources.astro 不动（06C 已内嵌）
- `/admin` 重写为真实数据版：AdminSidebar + 门禁 + 顶部状态条（城市选择/城市覆盖状态/系统健康状态，数据源 overview + public/system/status）+ 四指标卡（任务成功率/数据更新时间/已覆盖小区数/来源异常数）+ 近 7 日任务摘要 + 快捷入口；`PUBLIC_DEMO_DATA=1` 演示分支保留
- `/admin/jobs`：任务表（搜索/筛选/排序/分页）+ 行点击抽屉（§8.6 全字段、错误码高亮、workflow 链接、重跑幂等保护说明）
- `/admin/quality`：三类异常 tabs/筛选 + 表 + 抽屉（source/batch/connector_version/error_code 定位要素逐项展示）
- AdminSidebar：采集任务与日志→`/admin/jobs`、数据质量中心→`/admin/quality` 链接实化
- 视觉系统：深海军蓝导航 `--color-brand-900 #14253D`、白色主区、状态色与用户端一致（badge 语义复用 tokens.css）；颜色不作唯一编码（文字+图标）；**1440px/1024px 布局**：表格容器 `overflow-x:auto`，≤1024px 行切卡片视图（CSS media），关键操作不遮挡；新页一律带 `[hidden]{display:none!important}` 兜底（06C 教训）

## R8 测试与验收

- 单测 `admin-ops.test.ts`：门禁矩阵（401/403×2）、jobs 筛选/排序/分页/summary、quality 三类聚合与定位要素（batch_id/connector_version/error_code 非空断言）、overview ops 块四指标、internal 新字段落库、重跑幂等实证（同 batch 重提 duplicate 不重写、同观测重提行数不变、finish 幂等不改写）
- 全量回归：04B internal_jobs/04D/04E/06A/06B/06C 既有测试必须全绿
- 四门禁：pnpm typecheck / lint / test / build
- 浏览器实测（wrangler dev + astro dev + 桩网关，同 06C 方案）：登录 MFA → 总览四指标卡 → jobs 表筛选排序分页 + 抽屉 → quality 三类异常定位要素 → 1440/1024 两档布局截图存 docs/evidence

## 验收条款对照（任务行 1374）

1. 每一异常可定位 source、batch、connector version 和具体错误码 → R1 batch_id + R4 locator 形态 + R8 单测非空断言
2. 重跑有幂等保护 → R2 口径不变 + R8 幂等实证单测 + R7 页面说明
3. 1440px/1024px 布局清晰、表格小屏横向滚动或卡片视图、不遮挡关键操作 → R7 响应式 + R8 双档截图

## Out of Scope

- /admin/users 前端页、覆盖地图、事件投递后台、角色审计页、系统参数页（各自后续任务）
- §8.7 写操作（标记误报/确认异常/暂停指标/重处理批次）
- 重跑实际执行路径（Worker 不执行 connector）
- sources.astro 重构为共享门禁（保持 06C 原样，避免回归）

## 收尾实测补注

- 宽视口双档截图用 playwright-core + Edge 无头（内嵌浏览器面板 ~610px 不够）；Edge 无头到不了 CF Turnstile 挂件域，登录改走真实 API 链路（OTP 桩发码→verify-code→mfa/verify TOTP）后注入 pr_session——认证全程真实，仅挂件渲染环节不可达
- 实测发现并修复：Astro scoped 样式不命中 JS 动态插入的 tr/td，≤1024 卡片视图 media 失效——jobs/quality 两页样式块改 `<style is:global>`
