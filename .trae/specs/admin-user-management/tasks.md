# TASKS — TASK-06B 系统总览和用户管理

> 流程：SubTask 全勾后方可收尾 §12.0 报告，实际验收时逐项填写偏差。
> 备份 tag：`pre-v1-p2-task-06b` → d088da4。

## Task 0：流程启动

- [x] SubTask 0.1：读任务书行 1354–1360 + PRD §2.9 / §8.1–8.3 / §7.6 / §10.5；
      AskUserQuestion 四拍板（frozen+禁自冻结 / 停新事件停邮件数据保留 / GET+reason+审计 / §8.2 前7项）
- [x] SubTask 0.2：打 tag `pre-v1-p2-task-06b` → d088da4；写 spec/tasks/checklist 三件套

## Task 1：schemas 与错误码

- [x] SubTask 1.1：`schemas.ts` 加 `patchUserStatusSchema`（status enum + reason 8..500，
      additionalProperties false）；无新错误码（R7）

## Task 2：admin-users 路由

- [x] SubTask 2.1：`routes/admin-users.ts` 骨架 + `use("*", requireAdminAccess)` + `maskEmail`
- [x] SubTask 2.2：GET /admin/users（q 精确/status 筛选/分页/脱敏/watch_count/is_admin/deleted 排除）
- [x] SubTask 2.3：GET /admin/overview（R3 七组聚合查询，禁 N+1，零 PII）
- [x] SubTask 2.4：PATCH /admin/users/:id/status（自冻结 409、同状态 409、404、审计、返回 item）
- [x] SubTask 2.5：GET /admin/users/:id/monitoring（reason 10..500、404、明细+计数、审计）
- [x] SubTask 2.6：`app.ts` 挂载（adminAuthRoutes 之后）

## Task 3：冻结政策落点

- [x] SubTask 3.1：`rules-engine.ts` 两处查询加 `u.status='active' AND u.deleted_at IS NULL`
- [x] SubTask 3.2：`digest.ts` candidates 同过滤；`events.ts` 事件邮件取用户同过滤

## Task 4：测试与验收

- [x] SubTask 4.1：`admin-users.test.ts`（R8 全清单）
- [x] SubTask 4.2：`rules-engine.test.ts` + `digest.test.ts` 各增 frozen 用例
- [x] SubTask 4.3：四门禁全绿（typecheck / lint / test / build）
- [x] SubTask 4.4：e2e `e2e/admin-users.mjs`（端口 9617，两轮全过，进程树清理）

## Task 5：收尾（§12.0）

- [x] SubTask 5.1：中文 commit + push + 盯 CI 绿
- [x] SubTask 5.2：记忆更新（topics.md 06B 条目 / project_memory.md 新教训）
- [x] SubTask 5.3：`docs/TASK-06B-系统总览和用户管理验收报告.md`（含偏差记录）
