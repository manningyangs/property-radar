# TASK-06B 验收报告：系统总览和用户管理

> 任务书 V1.2 任务行 1354–1360 ｜ 基线 tag `pre-v1-p2-task-06b`（d088da4）
> Spec：`.trae/specs/admin-user-management/`（spec / tasks / checklist）

## 一、任务与拍板

目标：管理员查看用户状态和聚合监控统计。
边界：默认邮箱脱敏，不默认展示具体个人预算；查看个人监控明细要有理由并审计。
验收：聚合统计不泄露个人信息；冻结用户阻止登录/新建规则，既有数据按政策处理。

AskUserQuestion 四拍板（2026-11-16，均选推荐项）：

1. 冻结枚举 = **active / frozen** 两态；**禁止自冻结**（409 防自锁），冻结其他管理员放行但审计
2. 既有数据政策 = **冻结停新事件 + 停邮件，数据保留**（rules-engine / digest / events 邮件取用户加 `u.status='active' AND u.deleted_at IS NULL` 过滤；解冻即恢复，不删任何行）
3. 个人监控明细 = **GET /admin/users/:id/monitoring?reason=**（reason 必填 10–500 字符，成功查看强制写 audit_logs；访问日志只记路径不记查询串，reason 不落日志）
4. overview 范围 = **§8.2 前 7 项**（用户 / 监控聚合 / 事件 / 邮件 / 来源状态 / 今日任务 / 今日快照；费用用量属导航第 10 项，不在本任务）

## 二、交付内容

### 端点（新文件 `apps/api/src/routes/admin-users.ts`，挂 `requireAdminAccess` 统一门禁）

| 端点 | 行为 |
|---|---|
| `GET /api/v1/admin/overview` | §8.2 前 7 项聚合统计，响应零 PII（无 email / target_value / display_name_snapshot / user_id）；8 组查询 Promise.all 批量，禁 N+1；日期口径统一 UTC |
| `GET /api/v1/admin/users` | 列表：`q`（user_id 或完整邮箱规范化精确，不做 LIKE）、`status` 筛选、`limit/offset` 分页；item = user_id + email_masked + status + email_verified + created_at + last_login_at + is_admin + watch_count（聚合计数）；注销用户排除 |
| `PATCH /api/v1/admin/users/:id/status` | 冻结/解冻：body `{status, reason(8–500)}`；自冻结 409、同状态 409、目标不存在/已注销 404；审计 `admin.user.status`（reason=`旧→新｜理由`） |
| `GET /api/v1/admin/users/:id/monitoring` | 个人监控明细（含 target_value——全 API 唯一受控展示预算处）；reason 必填 10–500；审计 `admin.user.monitoring_view`（reason 原文）；404 不写审计 |

### 脱敏

`maskEmail`：local 前 2 字符 + `***` + 完整域名（local ≤2 保留首字符）。
`demo.a@example.com → de***@example.com`。明文 email_normalized 不出现在任何 06B 响应（含 monitoring 的 user 块）。

### 冻结政策落点（拍板 2）

- `rules-engine.ts`：`evaluateRulesForObjects` 与 `evaluateSystemEvents` 的查询 JOIN users 过滤 active 且未注销 → 冻结用户不产生新事件
- `digest.ts`：candidates 同过滤 → 不发每日摘要
- `events.ts`：事件邮件取用户同过滤（纵深防御，查不到走既有 EmailProviderError 路径）
- 登录/新建规则拦截：复用 02B `requireSession` 既有 `u.status='active'` 校验，零改动

### 数据与配置

零新迁移（users.status / audit_logs 复用）、零新错误码、零新环境变量。

## 三、验证结果

### 四门禁（全部通过）

| 门禁 | 命令 | 结果 |
|---|---|---|
| typecheck | `npm run typecheck` | ✅ |
| lint | `npm run lint` | ✅（prettier 格式化 2 文件后） |
| test | `npm run test` | ✅ 15 文件 / 262 用例（新增 admin-users 13 用例 + rules-engine/digest 各 1 冻结用例） |
| build | `npm run build` | ✅（API worker + web 13 页） |

### 单元测试要点（`admin-users.test.ts`）

- 门禁矩阵：4 端点 × 401 / 403 admin_required / 403 mfa_required
- overview：聚合值精确断言 + `JSON.stringify` 不含 `@` / user_id / `30000` / 监控内容
- users：脱敏格式、q 两种精确命中、status 筛选、分页、watch_count、is_admin、deleted 排除、明文邮箱不出现
- PATCH：冻结+审计行断言、解冻、同状态 409、自冻结 409、reason 缺失/过短 400、404；
  **冻结后既有会话 /me/* 401、解冻恢复 200**（验收条款实测）；watch/rules/sessions 行数不变（数据保留断言）
- monitoring：reason 缺失/过短 400（field=/reason）、404 不写审计、成功返回 target_value + 审计 reason 原文

### e2e（`e2e/admin-users.mjs`，wrangler dev 端口 9617，两轮全过）

33 项断言 × 2 轮：门禁矩阵 → bootstrap+MFA → overview 零 PII → users 脱敏（`e2***@example.com`）→
冻结 → target /me/* 401 → monitoring reason 校验 + 明细 → audit 两类动作可查（monitoring_view 恰 1 条、
reason 原文）→ 解冻恢复。脚本自带幂等种子清理，进程树 taskkill 收尾。

## 四、偏差记录

- 无 spec 偏差。开发中一处内部返工：`writeAudit` 初版返回 `.run()` Promise 被放进 `batch()`
  （batch 要求语句对象）导致 typecheck 报错，改为返回预编译语句后通过——实现细节，不影响验收。
- 测试断言一处误伤：`not.toContain("target-06b")` 与假名 user_id（usr-target-06b）前缀冲突，
  改为断言完整明文邮箱——假名 ID 允许出现，明文邮箱才是 PII。

## 五、遗留与后续

- 注销申请处理、数据导出/删除（US-12）不在 06B 范围（§8.3 列出但任务行 1354–1360 未含），归后续任务
- 费用用量（§8.2 第 8 组）与任务质量（§8.2 第 5/6 项细化）归 06C/06D
- 后台前端页面（admin UI 消费这些端点）属后续前端任务
