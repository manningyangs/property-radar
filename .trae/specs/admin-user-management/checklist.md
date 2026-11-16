# CHECKLIST — TASK-06B 系统总览和用户管理（验收门禁）

> 全部勾选后方可打「06B 完成」结论并写 §12.0 报告。

## 端点与门禁

- [x] GET /admin/overview、GET /admin/users、PATCH /admin/users/:id/status、
      GET /admin/users/:id/monitoring 四端点存在，挂 requireAdminAccess
- [x] 未登录 → 401；普通用户 → 403 admin_required；管理员未过 MFA → 403 mfa_required（4 端点全覆盖）

## 隐私边界（任务书边界条款）

- [x] 列表与明细一律 email_masked（de***@domain），明文 email_normalized 不出现在任何响应
- [x] overview 响应零 PII：无 email / target_value / display_name_snapshot / user_id（测试断言）
- [x] 不默认展示预算：target_value 仅 monitoring 端点返回
- [x] monitoring 必须 reason（trim 后 10..500），缺失/过短 → 400 validation
- [x] 访问日志确认不记查询串（reason 不落日志）

## 冻结语义（任务书验收条款）

- [x] 冻结后该用户既有会话请求 /me/*（含新建规则）→ 401（requireSession 既有校验，测试实测）
- [x] 解冻后同会话恢复可用（无需重新登录）
- [x] 自冻结 → 409；同状态重复 → 409；目标不存在/已注销 → 404
- [x] 冻结不删数据：watch_items/rules/events/sessions 行保留（测试断言计数不变）
- [x] rules-engine 两处 + digest candidates + events 邮件取用户均过滤 active 且未注销；
      frozen 用户不产生新事件、不发摘要/事件邮件（新增测试用例）

## 审计

- [x] admin.user.status：每次冻结/解冻落行，reason 含「旧→新｜理由」
- [x] admin.user.monitoring_view：每次成功查看落行，reason 原文；404 不落行

## 数据与配置

- [x] 零新迁移、零新错误码、零新环境变量（users.status/audit_logs 复用）
- [x] §9.4 不变量不受影响（未动 user-owned 表结构）

## 测试与 CI

- [x] `admin-users.test.ts` 全过；`rules-engine.test.ts` / `digest.test.ts` frozen 用例过
- [x] 既有测试回归全绿（不修改既有断言）
- [x] 四门禁：`npm run typecheck` / `npm run lint` / `npm run test` / `npm run build`
- [x] e2e `e2e/admin-users.mjs` 两轮全过（含冻结→401→解冻→恢复），端口/进程树清理干净
- [x] 中文 commit + push + CI success

## 记忆与文档

- [x] topics.md 06B 完成条目
- [x] project_memory.md 新教训（如有）
- [x] `docs/TASK-06B-系统总览和用户管理验收报告.md`（含偏差记录）
