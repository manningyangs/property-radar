# TASK-07B 数据合规检查 — Spec

任务书行 1384：逐数据源复核许可范围；逐页面核对数据来源展示；检查隐私政策、用户协议、数据导出删除、保留期限和第三方处理者说明。

上线门槛（任务书 1395/1599）：核心数据真实、合法授权、来源可追溯；用户数据隔离、账号删除、隐私政策、管理员审计完成。

基线 tag：`pre-v1-p2-task-07b`（e064317）。

## 0. 拍板决策（AskUserQuestion，用户全选推荐项）

1. **修复范围=全部落地**：新建 `/privacy`、`/terms` 页面全文；实现 `POST /me/export`（JSON 单文件）与 `POST /me/delete-account`（注销）；account.astro 接线替换全部「暂未开放」stub
2. **注销语义=冷静期 7 天 + 到期硬删**：请求即标记 `deletion_pending` 并吊销全部会话、停止事件/邮件产生；期内重新登录可撤销；cron 到期后硬删全部个人数据；审计日志按 PRD 0001 注释保留（actor 不设外键即为用户注销后日志仍完整）
3. **导出格式=JSON 单文件**（可机读，符合可携带权；不做 CSV）
4. **处理者信息=占位**：运营者「房价雷达（Property Radar）」、联系邮箱占位 `privacy@property-radar.example`，文档内显式标注「开放注册前必须替换为真实邮箱」，列入 07C 上线检查清单

## 1. 现状检查结论（探查实证）

### 1.1 逐数据源许可复核（config/sources/data-sources.json，10 源）

| source_code | status | allowed_automatic | 连接器 | 复核结论 |
|---|---|---|---|---|
| stats_nbs_70city | approved_open | true | 无 | 许可合格；尚未接连接器，合规 ✅ |
| sz_zjj_secondhand_daily | approved_open | true | 无 | 许可合格但指标不满足价格需求，无连接器 ✅ |
| qd_stats_price_index | approved_open | true | qingdao_index.py | 状态与连接器一致 ✅ |
| qd_zjj_trade_platform | manual_only | false | 无 | 无许可前禁自动，合规 ✅ |
| hz_open_data | pending_review | false | 无 | 合规 ✅ |
| beike_open_platform | pending_review | false | 无 | 无贝壳爬虫（上线门槛）✅ |
| lianjia | manual_only | false | 无 | ✅ |
| anjuke | manual_only | false | 无 | robots/协议明确不利，无爬虫 ✅ |
| fang_com | approved_licensed | true | fang_community.py | 负责人 2026-11-12 裁决留痕（04D）；低频手工触发、不存 HTML、不入 cron——与 limitations 一致 ✅ |
| user_manual_record | approved_open | false | — | 永远 user_reported 口径，不自动抓取 ✅ |

DB 侧：`source_approvals` 含 approver_user_id/evidence_ref/retention_period（§5.3 行 450 要素）；allowlist.py + 运行门禁强制「仅 approved_* 可采集」。collectors 目录无未授权平台连接器。

### 1.2 逐页面来源展示核对

- 有价格/事件数据且已展示来源：`index`（SourceAttribution）、`community`（SourceAttribution+主卡 source）、`region`（SourceAttribution+图注）、`regions`（图注）、`communities`（item.source）、`events`（source 字段）、`briefing`（口径与来源声明）、`account`（SourceAttribution/EmptyState 分支）✅
- 不含行情数字的用户输入页：`login`、`watch/index`、`watch/add`、`rules`、`account` 操作区 —— 不适用
- 管理端：`admin/sources` 06D 来源中心（许可/审批/复核时间）✅

### 1.3 缺口（本任务修复项）

1. 隐私政策/用户协议全文不存在：account.astro「隐私政策全文」为 data-soon stub（PRD 行 703 必备要素缺失）
2. `POST /me/export`、`POST /me/delete-account` 为 501 stub（me.ts:1154-1161）；account.astro 导出按钮「暂未开放」、注销仅清本地演示会话
3. 保留期限实现已有（OTP 10min+1 天清理、会话 30 天、推送 60 天休眠清理、IP 仅存指纹哈希、nonce 过期清理）但未成文披露；注销后云端数据无删除路径

## 2. 实施方案

### 2.1 Migration（packages/migrations 私有库）

新增 `db/migrations/private/0016_account_deletion.up.sql`（私有库已有 0009_job_run_type，顺延至 0016）：
- `ALTER TABLE users ADD COLUMN deletion_requested_at TEXT;`（+migrate-idempotent 指令容忍重复执行）
- down：`ALTER TABLE users DROP COLUMN deletion_requested_at;`
- `packages/migrations/src/index.test.ts` 增补 0016 列存在断言

### 2.2 API（apps/api）

**POST /me/delete-account**（routes/me.ts 替换 stub）：
- strict schema：`{ confirm: z.literal(true) }`（缺失/false → 400）
- 守卫：`deleted_at IS NOT NULL` → 404；active admin_roles（revoked_at IS NULL）→ 403「管理员账号须先撤销角色」
- 动作：`UPDATE users SET status='deletion_pending', deletion_requested_at=datetime('now')`（幂等：已 pending 直接返回同响应）；`UPDATE sessions SET revoked_at=now WHERE user_id=? AND revoked_at IS NULL`；deleteCookie 会话
- 响应 200：`{ status: "deletion_pending", purge_after_days: 7 }`
- 后续效果：requireSession 与 rules-engine/digest 均只认 `status='active'`（06B 已实现），pending 用户自动停止事件/邮件

**登录撤销冷静期**（routes/auth.ts verify-code，行 242 分支）：
- `deleted_at` 或 `status='frozen'` → 维持拒绝「账号不可用」
- `status='deletion_pending'` → `UPDATE users SET status='active', deletion_requested_at=NULL`，继续签发会话，响应加 `deletion_cancelled: true`

**POST /me/export**（routes/me.ts 替换 stub）：
- 空 body（jsonBody 校验 `{}`）；聚合本人：account（user_id/email/created_at/last_login_at/email_verified_at/status）、watch_items（含 inactive）、watch_rules+watch_rule_settings、watch_item_groups、alert_events、notification_preferences、push_subscriptions、city_coverage_requests、user_cities、user_consents
- 响应 `application/json` + `Content-Disposition: attachment; filename="property-radar-export-YYYY-MM-DD.json"`；仅 session 用户数据（IDOR 天然隔离）

**到期硬删**（新模块 `apps/api/src/deletion.ts`）：
- `purgeExpiredDeletions(db: D1Database): Promise<{ purged: number }>`：
  - 选择 `status='deletion_pending' AND deletion_requested_at < datetime('now','-7 day')`
  - 每用户按序删：watch_item_groups（按 watch_id）、watch_rule_settings（按 rule_id）、notification_deliveries、alert_events、watch_rules、watch_items、notification_preferences、push_subscriptions、user_consents、city_coverage_requests、user_cities、sessions、email_otps（按 email_normalized）、users
  - 保留：audit_logs（0001 注释：注销后日志仍完整）、email_send_ledger（无 PII 列）、ingest_*（非个人数据）
- index.ts scheduled：CRON_DAILY_DIGEST 分支追加独立 `ctx.waitUntil(purge...)`+catch，日志 `request_id: "cron-deletion-purge"`

### 2.3 Web（apps/web）

- 新建 `src/pages/privacy.astro`：隐私政策全文（版本 v1.0 / 2026-11-16），覆盖 PRD 703 七要素：处理者（占位+替换标注）、处理目的、处理方式、个人信息类别（邮箱/监控对象/目标价/通知偏好/操作记录/IP 指纹哈希/推送 endpoint）、**保存期限表**（OTP 10 分钟且行 1 天内清理、会话 30 天、推送订阅 60 天不活跃删除、注销冷静期 7 天后硬删、审计日志合规保留）、用户权利与入口（访问/更正=账户页、导出=/me/export、删除=注销、撤回同意=通知偏好）、联系途径（占位邮箱）、**第三方处理者**：Cloudflare（Workers/Pages/D1/Turnstile/Web Push）、Google（Apps Script 邮件网关；仅用于发送验证码/提醒/摘要）、跨境说明（数据在境外基础设施处理；开放注册前由专业人员核验跨境合规——PRD 705 如实转述）
- 新建 `src/pages/terms.astro`：用户协议（服务性质=行情监控提醒非交易建议、账号规则、数据口径与免责、可接受使用、通知配额、服务变更与终止、版本）
- `src/lib/api.ts`：me 命名空间增 `exportData()`、`deleteAccount()`
- `src/pages/account.astro` 接线：
  - 导出按钮 → `api.me.exportData()` → Blob 下载 `property-radar-export-*.json`；401 → toast「请先登录云端账号」；移除 data-soon stub
  - 注销 ConfirmDialog 文案改冷静期语义；确认后调 `api.me.deleteAccount()`，成功 toast「已提交注销：会话即时失效，7 天内重新登录可撤销，到期云端数据永久删除」；本地演示会话清理保留
  - 「隐私政策与用户协议」→ 链接 `/privacy`、`/terms`（移除「暂未开放」）
  - privacy-list 首条补「完整条款见隐私政策」链接
- AppShell 页脚（若存在）补 /privacy /terms 链接；不存在则不动（避免范围外重构）

### 2.4 测试（apps/api）

新增 `apps/api/src/data-compliance.test.ts`（沿用既有 harness）：
1. export：字段全集断言；A 导出不含 B 数据；无会话 401；Content-Disposition 断言
2. delete-account：confirm 缺失/非 true → 400；成功 → DB status/deletion_requested_at、全部会话 revoked、旧 cookie 后续请求 401、重复调用幂等 200；管理员角色用户 → 403；deleted_at 用户 → 404
3. 冷静期撤销：pending 用户走完整 OTP 登录 → status 回 active、deletion_requested_at NULL、响应 deletion_cancelled=true、新会话可用；frozen/deleted 仍拒
4. purge：8 天前 pending 用户全表行删除+用户行删除+审计保留；6 天前 pending 用户保留；返回 purged 计数

## 3. 验证与证据

- 四门禁：`pnpm typecheck` / `pnpm lint` / `pnpm test`（api/shared/migrations 全绿，基线 api 318+新增）/ `pnpm build`（16→18 页）
- 实测证据存 `docs/evidence/07b-*`：
  - 07b-01：data-compliance.test.ts + auth/me 回归运行记录
  - 07b-02：本地栈（wrangler 8789 + 桩网关 + astro 4321）真实登录 → 导出下载 JSON 内容截图/存样
  - 07b-03：注销 → 会话失效 → 冷静期登录撤销 实测记录
  - 07b-04：/privacy、/terms 页面 1440px 截图（playwright-core+msedge）
  - 07b-05：逐页面来源展示核对截图（community/events）
- CI 盯 success；验收报告 `docs/TASK-07B-数据合规检查验收报告.md`（含 §1.1 许可复核表、§1.2 页面核对表、保留期限清单、第三方处理者清单、07C 待办：占位邮箱替换+跨境专业核验）

## 4. 红线与边界

- 不实现任何新爬虫/不改采集许可；不动 fang_com 裁决记录
- 审计日志、email_send_ledger 不删（非个人 PII 或合规要求保留）
- 隐私政策文本如实反映现状，不虚构不存在的功能入口；占位信息显式标注
- 工作区根的任务书副本不提交
