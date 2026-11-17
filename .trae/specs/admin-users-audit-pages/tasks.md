# TASKS — TASK-10 后台前端页:用户管理 + 角色审计

## T1 [x] API 层与侧栏
- lib/api.ts：AdminUserItem/AuditItem/UserMonitoring 类型 + adminUsers/adminAudit/adminUserMonitoring/patchUserStatus 函数
- AdminSidebar.astro：两项加 href、去徽章

## T2 [x] 用户管理页 /admin/users
- 搜索+状态chips+分页表格；冻结/解冻 ConfirmDialog+理由；监控抽屉（理由≥10、审计提示）；deletion_pending 徽章+说明；401/403/409/400 如实处理

## T3 [x] 角色与审计页 /admin/audit
- 三筛选+分页表格；动作图例；角色说明块（bootstrap 授予、无吊销 API 偏差留痕）

## T4 [x] 验收
- 浏览器实测两页全链（会话注入）+ 审计闭环实证（monitoring_view 行可查）+ 截图
- 四门禁：api vitest 回归 / typecheck / lint / build

## T5 [x] 收尾
- 验收报告 docs/TASK-10-*.md；记忆；commit/push/CI
