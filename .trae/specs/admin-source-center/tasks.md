# TASK-06C 任务清单

## Task 0 流程启动
- [x] SubTask 0.1 读任务书 1362–1368 + PRD §8.1/§8.4/§5.3 + 探查现状（admin.astro 静态演示、04A API、组件 props）
- [x] SubTask 0.2 打 tag pre-v1-p2-task-06c + AskUserQuestion 四拍板 + spec 三件套

## Task 1 API：审批历史 + health 合并（R1/R2）
- [ ] SubTask 1.1 admin.ts：GET /sources/:id/approvals（loadSource 404 → source_approvals 倒序 ≤100，JSON 字段解析）
- [ ] SubTask 1.2 admin.ts：GET /sources 列表批量合并 health_status（最新 source_health_reports）+ last_success_at（最近 succeeded ingest_jobs）
- [ ] SubTask 1.3 单测 admin-sources.test.ts：门禁矩阵 / 404 / 多次审批全保留 / 倒序 / health 断言

## Task 2 前端 API 层（R3）
- [ ] SubTask 2.1 api.ts：admin 端点函数 + 类型（AdminSourceItem/ApprovalRecord/MfaStatus）

## Task 3 页面（R4）
- [ ] SubTask 3.1 components/AdminSidebar.astro（10 项导航 + active）
- [ ] SubTask 3.2 pages/admin/sources.astro：门禁状态机（getMe→mfa/status→三面板）
- [ ] SubTask 3.3 列表渲染 + 搜索/筛选 + 抽屉（元数据/coverage/审批历史/审计）
- [ ] SubTask 3.4 操作表单：登记/PATCH/审批（完整字段）/停用，全部 ConfirmDialog
- [ ] SubTask 3.5 admin.astro 导航「数据源中心」改为链接 /admin/sources

## Task 4 门禁与 e2e
- [ ] SubTask 4.1 四门禁：typecheck / lint / test / build
- [ ] SubTask 4.2 浏览器实测：wrangler dev + astro preview，登录→MFA→列表→审批→停用→历史走查截图

## Task 5 收尾
- [ ] SubTask 5.1 中文 commit + push + 盯 CI success
- [ ] SubTask 5.2 记忆更新（project_memory + topics）
- [ ] SubTask 5.3 验收报告 docs/TASK-06C-数据源管理后台验收报告.md + 勾选三件套
