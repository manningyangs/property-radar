# TASK-06C 验收清单

## 验收条款（任务行 1368）
- [x] 未审批不能启用：前端审批按钮仅对 discovered/pending_review/manual_only/suspended 显示；后端 04A 门禁回归（未审批不进公开、approve 必须完整证据）
- [x] 审批记录不可无痕修改：source_approvals append-only（无 UPDATE/DELETE 路径）+ GET approvals 历史全量展示 + 单测断言多次审批全部保留
- [x] 来源暂停后 connector 任务自动阻止：04A/04B source-gate/ingest 既有回归全绿 + 页面暂停后状态徽章同步

## R1 审批历史端点
- [x] GET /admin/sources/:id/approvals 门禁（401/403/403 mfa_required）
- [x] 不存在来源 404 source_not_found
- [x] created_at DESC 排序、≤100 条、JSON 字段解析为数组
- [x] 响应仅 {items,count}，不写审计

## R2 health 合并
- [x] health_status 取最新 source_health_reports.status，无记录 unknown
- [x] last_success_at 取最近 succeeded ingest_jobs.finished_at，无则 null
- [x] 批量查询无 N+1（每 source 常数次查询）

## R3 前端 API 层
- [x] 10 个 admin 函数 + 类型完整；401 跳 /login?next=/admin/sources

## R4 页面
- [x] AdminSidebar 10 项导航 + active；/admin 与 /admin/sources 互通
- [x] 门禁状态机：未登录跳登录；未绑定→setup 面板；已绑未验→TOTP 面板；已验→数据
- [x] 列表：徽章/到期警示/覆盖数/health/更新时间 + 搜索 + 状态筛选
- [x] 抽屉：元数据 + coverage + 审批历史（标注 append-only）+ 操作审计
- [x] 登记/编辑/审批/停用四操作，ConfirmDialog 二次确认，审批表单字段对齐 approveSourceSchema
- [x] 空态/错误 toast；演示构建不注入本页

## R5 验证
- [x] npm run typecheck / lint / test / build 全绿
- [x] admin-sources.test.ts 新用例全过；04A/04B 回归全绿
- [x] 浏览器实测走查完成（登录→MFA→列表→审批→停用→历史），截图存证
- [x] 中文 commit + push + CI success
- [x] 记忆更新 + 验收报告
