# CHECKLIST — TASK-10（验收门禁）

## T1
- [x] api.ts 类型与函数齐（沿用 adminFetch 口径）
- [x] 侧栏两项可点、徽章 6→4，其余四项不动

## T2
- [x] 列表/搜索（精确匹配提示）/状态chips/分页可用
- [x] 冻结/解冻：理由 8-500 前端校验；409（自锁/同状态）如实 toast；成功后行内状态更新
- [x] 监控抽屉：理由 <10 拦截；提交后展示 watch+rules；明示"已写入审计"
- [x] deletion_pending 徽章+冷静期说明；email 仅脱敏展示

## T3
- [x] 三筛选精确生效；分页可用；空态诚实
- [x] 角色说明块含"无吊销 API"偏差留痕

## T4
- [x] 浏览器实测两页全链 + 审计闭环（monitoring_view 可查）+ 截图入 evidence
- [x] api vitest 全绿 / typecheck 0 错 / lint 绿 / build 绿

## T5
- [x] 验收报告 / 记忆 / 勾选 / 中文 commit+push+CI 全绿

## 红线
- [x] 后端零改动（git diff 不含 apps/api）
- [x] 无新依赖；无真实 PII 入仓库/截图（本地 e2e 数据除外）
