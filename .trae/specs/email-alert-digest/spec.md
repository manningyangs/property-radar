# SPEC — TASK-05B 邮件提醒和每日摘要

> PRD 任务行 1328–1334：①达到目标后发送事件邮件，内容包含对象、指标、目标与当前值、差值、数据日期、来源、样本量与链接，且不暴露内部字段名；②发送每日摘要邮件，**发送幂等、每日限额、失败重试有限**。
> 关联章节：§6.6（07:30 每日摘要 Worker cron、邮件失败补偿）、§7.2（每日摘要+目标价事件邮件内容要求）、§7.3（通知渠道与发送失败回退站内可见）、§7.4（邮件偏好默认开摘要默认关）、§8.8/§11.2–11.3（80 封/24h 硬帽、OTP 预留 60、达到上限按受限状态记录、不得自动切付费）、§9.2 notification_preferences/email_send_ledger。
> 备份 tag：`pre-v1-p2-task-05b`（HEAD=5f31fc0，工作树干净）。

## 0. 已拍板决策（用户 2026-11-13 确认）

1. **邮件网关**：Worker 侧 `sendEvent/sendDigest` 全链路 + 更新 `apps-script/mail_gateway.gs` 模板实现；e2e 用测试桩/mock 网关验证签名与幂等；**真实发信等用户重新部署 .gs 后由用户触发验证**。
2. **摘要调度**：全局 cron 北京 07:30（`30 23 * * *` UTC）一次处理全部 `digest_enabled` 用户；**digest_time 字段保留可存但本期不生效**（统一 07:30）。
3. **额度口径**：事件邮件与摘要邮件**与 OTP 共享 80 封/滚动 24h 总帽**，通知侧可用额度 = 总帽 − OTP 预留 60（即 20 封起步，随 OTP 实际用量动态）；达限新投递落 `quota_deferred` 站内保留，账本记 `quota_blocked`；**不自动切换付费服务**。
4. **失败重试**：立即重试 1 次（共 2 次尝试），仍失败 `email` 行落 `provider_error`（attempt_count=2），站内事件始终保留；延迟重试队列留后续任务。

## R1 — 事件邮件（price_alert）

- R1.1 `dispatchNotification` 在既有 `sendEmail` 接缝上接真实发送：发送前查额度 → 调 `EmailProvider.sendEvent` → 写 `notification_deliveries.email` 行状态。
- R1.2 邮件正文按 §7.2 字段：对象名称、指标中文名、目标值、当前值、差值（数值与百分比）、数据统计日期、来源名称、样本量、链接（指向站内对象/事件页）。**正文不得出现任何内部字段名/表名/列名**（如 difference_pct、metric_code、community_key）。
- R1.3 `EmailProvider` 接口扩展 `sendEvent` / `sendDigest`（新结构化入参），`GoogleAppsScriptMailProvider` 走既有 HMAC 网关（模板名 `price_alert`/`daily_digest`）；OTP 路径零改动。
- R1.4 事件邮件幂等：`notification_deliveries` 中该 `event_id + channel='email'` 行已存在（非 quota_deferred）则不重复发送；`createEvent` 既有 event_key 幂等继续兜底。

## R2 — 每日摘要（daily_digest）

- R2.1 新增摘要生成函数：取 `notification_preferences.digest_enabled=1` 且 `email_enabled≠0` 的用户，聚合**上一北京日**新建 `alert_events`（类型分布、最高级别、未读数、监控对象数），无事件的用户跳过不发。
- R2.2 幂等键 `digest:{user_id}:{北京日期}` 写入 `email_send_ledger.request_id`，发送前查重——同一用户同一日只发一封（cron 重复触发/手动补跑安全）。
- R2.3 摘要正文含 §7.2 要求的昨日价格变化/事件/监控状态概述 + 事件明细（对象、类型、变化摘要、链接），同样不暴露内部字段名。
- R2.4 调度：`wrangler.jsonc` crons 追加 `30 23 * * *`（= 北京 07:30）；`index.ts` scheduled 调摘要函数，与既有事件评估 cron 相邻触发、互不阻塞（各自 try/catch + logError）。

## R3 — 幂等 / 限额 / 重试（验收核心）

- R3.1 **发送幂等**：事件邮件按 R1.4（delivery 行唯一）；摘要按 R2.2（ledger request_id 查重）；重复 evaluate/重复 cron 不产生重复邮件。
- R3.2 **每日限额**：发送前共享总帽核验（复用 `emailQuotaUsed` 口径：`email_send_ledger` 滚动 24h `sent` 合计 ≥ 80，或通知侧已用量 ≥ 80−60）→ 达限则**不调用 provider**，`notification_deliveries.email` 行写 `status='quota_deferred'`（attempt=0）、`email_send_ledger` 写 `status='quota_blocked'`、站内事件保留；摘要同理跳过该用户并在响应/日志记 `quota_blocked` 计数。
- R3.3 **失败重试有限**：provider 抛错 → 立即重试第 2 次 → 仍失败则 email 行 `provider_error`、`attempt_count=2`、`last_error_code` 为分类码；**错误消息/邮箱不落库不落日志**。
- R3.4 **不暴露**：delivery/ledger/日志均不存收件邮箱明文（沿用 02C 既有约定）。

## R4 — 测试桩与 .gs 模板

- R4.1 vitest 通过既有 `dispatchOpts.sendEmail` 注入点 + 摘要函数的可选 provider 参数注入桩（成功桩、抛错桩、慢路径不涉及），不改生产接线默认值。
- R4.2 `apps-script/mail_gateway.gs`：实现 `price_alert` 与 `daily_digest` 模板（HTML 邮件，字段映射同 R1.2/R2.3，未知模板仍拒绝），保持既有 HMAC 验签/防重放/模板白名单结构；**交付文件即可，用户重新部署后真实发信验证**。

## 非目标（Non-Goals）

- digest_time 生效（每小时对时调度）；延迟重试队列（cron 补偿）；Brevo/Resend 迁移；浏览器推送；摘要前端设置页（API 已有 PATCH /me/notification-preferences）；digest 空邮件（无事件不发）。
- 前端零新增页面：本期不改 `apps/web`（事件邮件/摘要均为服务端行为；事件中心 05A 已交付展示）。

## 验收映射

| PRD 验收                                                                     | 落点                                                                                   |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 事件邮件内容含对象/指标/目标/当前/差值/日期/来源/样本量/链接、不暴露内部字段 | R1.2 + vitest 断言正文字段齐全且不含 `metric_code`/`_key`/表名列名                     |
| 发送幂等（同事件/同日不重复）                                                | R1.4 + R2.2 + 复跑测试零新增 ledger sent 行                                            |
| 每日限额                                                                     | R3.2 + vitest 预置 ledger 满额 → provider 不被调用 + quota_deferred/quota_blocked 落行 |
| 失败重试有限                                                                 | R3.3 + 抛错桩 2 次尝试计数断言、站内事件保留                                           |
| 每日摘要 cron                                                                | R2.4 + 手动触发本地 scheduled 验证                                                     |
| 邮件失败回退站内                                                             | 05A 已交付（in_app 独立于 email 状态），05B 测试复断言                                 |
| OTP 额度不受影响                                                             | R3.2 共享口径 + 既有 auth.test 额度测试回归                                            |

## 风险与回滚

- **额度抢占**：通知与 OTP 共享 80，若摘要批量发送挤占 OTP——通知侧上限=80−60 已天然保 OTP 预留；auth 路径原判定不变（双重保护）。
- **cron 双发**：摘要幂等键查重兜底；回滚 = `wrangler rollback` + git revert（新 cron 随 wrangler 配置回滚消失）。
- **.gs 部署**：部署前网关对新模板返回「模板未实现」→ Worker 落 `provider_error`，站内事件不受影响（正是 R3.3 路径），符合 §8.8。
- **零迁移**：全部复用 0001/0002 既有列（ledger.request_id、deliveries.status 枚举由应用层写入）。
