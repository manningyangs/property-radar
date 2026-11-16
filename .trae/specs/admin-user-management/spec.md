# SPEC — TASK-06B 系统总览和用户管理

> 任务书：`d:\Program Files\download\房价雷达_PRD与Trae开发任务书_V1.2.md` 任务行 1354–1360
> 目标：管理员查看用户状态和聚合监控统计。
> 边界：默认邮箱脱敏，不默认展示具体个人预算；查看个人监控明细要有理由并审计。
> 验收：聚合统计不泄露个人信息；冻结用户会阻止登录/新建规则，但按政策处理既有数据。
> 备份 tag：`pre-v1-p2-task-06b` → d088da4。
>
> 拍板（AskUserQuestion，2026-11-16）：
> 1. 冻结枚举 = **active / frozen**（两态；注销仍走 deleted_at）；**禁止自冻结**（409），冻结其他管理员放行但审计
> 2. 既有数据政策 = **冻结停新事件+停邮件，数据保留**（rules-engine/digest/事件邮件查询加 `u.status='active' AND u.deleted_at IS NULL` 过滤；解冻即恢复）
> 3. 个人监控明细端点 = **GET /admin/users/:id/monitoring?reason=**（reason 必填 ≥10 字符；访问日志只记路径不记查询串故不泄露；每次成功查看写 audit_logs）
> 4. overview 范围 = **§8.2 前 7 项**（用户/监控聚合/事件/邮件/来源状态/今日任务/今日快照；费用用量属导航第 10 项，不在本任务）

## 现状（d088da4）

- `users.status` 列已存在（默认 'active'，应用层约束）；`requireSession` 已校验 `u.status='active'`
  → 冻结天然阻止登录与全部 /me/*（含新建规则），无需改动。
- 06A 设施复用：`auth.requireAdminAccess`（会话+角色+MFA）、`audit_logs` 表、`admin-auth.ts` 门禁模式。
- `rules-engine.ts:337/412`、`digest.ts:66`、`events.ts:161` 均**不过滤用户状态**——拍板 2 需补。
- 无 /admin/users* 与 /admin/overview 端点；无新迁移需求（users/audit_logs/聚合查询全部已有）。

## 需求

### R1 新路由文件 `routes/admin-users.ts`（app.ts 挂载于 adminAuthRoutes 之后）

- `adminUsersRoutes.use("*", requireAdminAccess)`：全部端点 = 会话 + 角色 + MFA（无豁免路径）。
- 端点：

| 端点 | 行为 |
|---|---|
| `GET /admin/overview` | 聚合统计（R3），零个人信息 |
| `GET /admin/users` | 用户列表（R2）：查询/筛选/分页，邮箱默认脱敏 |
| `PATCH /admin/users/:id/status` | 冻结/解冻（R4）：reason 必填 ≥8，审计，自冻结 409，同状态 409 |
| `GET /admin/users/:id/monitoring` | 个人监控明细（R5）：reason 必填 ≥10，强制审计 |

### R2 GET /admin/users（列表与脱敏）

- query：`q`（user_id 精确 **或** 完整邮箱规范化精确，trim+lower；不做 LIKE 模糊）、
  `status`（active\|frozen，非法 400 validation）、`limit`（默认 20，≤100）、`offset`（≥0）。
- 条件：`deleted_at IS NULL`（注销用户不进列表）；`ORDER BY created_at DESC, user_id DESC`。
- item 字段：`user_id, email_masked, status, email_verified(bool), created_at, last_login_at,
  is_admin(bool), watch_count`（该用户 status='active' 的 watch_items 数，聚合计数不含内容）。
- 响应：`{items, total, limit, offset}`。
- **maskEmail**（放 `admin-users.ts` 内，唯一使用方）：local 保留前 2 字符 + `***` + 完整域名；
  local ≤2 字符保留首字符。`demo.a@example.com → de***@example.com`。
  明文 email_normalized 绝不出现在任何 06B 响应（monitoring 端点也用脱敏）。

### R3 GET /admin/overview（§8.2 前 7 项，全部聚合）

```
users:      { total, active, frozen, new_7d, active_7d }        // total 排除 deleted；active_7d=last_login_at ≥ now-7d
monitoring: { watches_active, by_object_type: {region, community, listing}, rules_enabled }
            // rules_enabled 联 watch_items(status=active) 与 users(active 且未注销)——冻结用户不计入
events:     { today, last_7d }                                   // alert_events.created_at
email:      { last_7d: { sent, provider_error, quota_deferred, success_rate } }
            // notification_deliveries channel='email'；success_rate=sent/(sent+provider_error)，分母 0 → null
sources:    { by_status: {<status>: n} }                         // public source_license_state GROUP BY
jobs:       { today: { succeeded, failed, running } }            // private ingest_jobs date(started_at)=date('now')
snapshots:  { today_valid }                                      // public price_snapshots date(collected_at)=今天 AND quality_status='valid'
```

- 日期口径统一 UTC（datetime('now') 本身 UTC），与 04B 任务记录一致。
- 响应任何字段不得含 email、target_value、display_name_snapshot、user_id。

### R4 PATCH /admin/users/:id/status

- body schema `patchUserStatusSchema`：`{status: enum ['active','frozen'], reason: string 8..500}`，
  required 两者，additionalProperties false；reason 先 trim 再校验（惯例：规范化先于校验）。
- 目标不存在或已注销 → 404 `not_found`（message「用户不存在」）。
- **自冻结**：`c.get("userId") === 目标 && status==='frozen'` → 409 conflict「不能冻结自己的账号」。
- 同状态重复设置 → 409 conflict（防误操作双提交）。
- 通过 → `UPDATE users SET status=?`；审计 `admin.user.status`
  （resource_type='user'，resource_id=目标，reason=`${old}→${new}｜${reason}`）；
  返回 `{ user: <R2 item 形态> }`。
- 生效语义（拍板 2）：冻结即时阻断该用户全部会话（requireSession 每请求查 status）；
  不撤销 sessions 行、不删任何数据；解冻即恢复。

### R5 GET /admin/users/:id/monitoring（有理由 + 审计）

- query `reason`：必填、trim 后 10..500 字符，否则 400 validation（field `/reason`）。
- 目标不存在/已注销 → 404。
- 响应：`{ user: {user_id, email_masked, status, created_at, last_login_at},
  watches: [ {watch_id, object_type, object_id, display_name_snapshot, priority, status, created_at,
  rules: [{rule_id, rule_type, metric_code, price_type, target_value, currency, unit, window_days,
  threshold_pct, is_enabled, armed_state}]} ], counts: { watches, rules } }`
  （含 target_value——本端点存在意义即「受控查看预算」）。
- 审计 `admin.user.monitoring_view`（resource_id=目标，reason=原文），成功响应前落行；404 不写。

### R6 冻结政策落点（拍板 2，最小改动）

- `rules-engine.ts` `evaluateRulesForObjects`（行 337 查询）与 `evaluateSystemEvents`（行 411）：
  JOIN users u → `AND u.status='active' AND u.deleted_at IS NULL`。
- `digest.ts` candidates（行 66）：同上过滤。
- `events.ts` 事件邮件取用户（行 161）：`AND status='active' AND deleted_at IS NULL`，
  查不到走既有 EmailProviderError 路径（纵深防御：新事件已被 rules-engine 拦下）。
- 不改动：登录/OTP 发送（requireSession 已拦）、watch/rules 写端点（requireSession 已拦）。

### R7 错误码与配置

- 零新错误码（复用 not_found/conflict/validation_failed/admin_required/mfa_required/unauthorized）。
- 零新迁移、零新环境变量。

### R8 测试与验收

- `admin-users.test.ts`（新）：门禁矩阵（4 端点 × 401/403/403 mfa_required）；
  overview 各聚合值精确断言 + 响应 JSON 字符串不含邮箱域/target_value/用户ID；
  users 列表脱敏格式、q 两种精确命中、status 筛选、分页 total、watch_count、is_admin、deleted 排除；
  PATCH 冻结成功+审计行、解冻、自冻结 409、同状态 409、reason 过短 400、目标 404、
  冻结后该用户 token 请求 /me/* → 401（验收「阻止登录/新建规则」）；
  monitoring reason 缺失/过短 400、成功返回 rules 含 target_value、审计行含 reason 原文。
- `rules-engine.test.ts` 增 1 用例：frozen 用户规则不产生新事件（active 用户对照）。
- `digest.test.ts` 增 1 用例：frozen 用户不进摘要候选。
- 四门禁：`npm run typecheck` / `npm run lint` / `npm run test` / `npm run build`。
- e2e `e2e/admin-users.mjs`（端口 9617）：种子 3 用户（admin/target/plain，target 带 watch+rule）→
  门禁 → bootstrap+MFA → overview 200 聚合断言 → users 列表脱敏断言 → PATCH 冻结 →
  target token /me/* 401 → monitoring reason 缺失 400 → 带 reason 200 → audit 两类动作可查 → 解冻恢复登录。

## DoD

- [ ] R1–R7 实现且四门禁全绿
- [ ] R8 测试全过 + e2e 两轮全过
- [ ] 中文 commit + push + CI success
- [ ] 记忆更新 + `docs/TASK-06B-系统总览和用户管理验收报告.md`
