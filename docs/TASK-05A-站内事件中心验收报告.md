# TASK-05A 站内事件中心验收报告

> PRD 任务行 1322–1326：展示目标价、降价、数据异常和更新延迟事件；邮件 provider 不可用时站内事件依然保留；用户只能访问自己的事件。
> 规格：`.trae/specs/in-app-event-center/{spec.md,tasks.md,checklist.md}`（R1–R6）；备份 tag `pre-v1-p2-task-05a`（HEAD=f02bda7）。

## 1. 交付概览

| 层 | 交付 |
|---|---|
| 事件生成（并入 03C 核心） | `apps/api/src/rules-engine.ts`：`evaluateRulesForObjects`（目标价/跌幅状态机 + 质量门控）、`evaluateSystemEvents`（延迟/异常）；`apps/api/src/events.ts`：`createEvent` + `dispatchNotification` 投递占位 |
| 触发入口 | 批次/补录写入后同步评估（`internal.ts` batch、`admin.ts` observations）；`POST /internal/events/evaluate`（HMAC 签名链）；Worker `scheduled` cron `30 0 * * *`（UTC，北京 08:30） |
| 事件接口 | `GET /me/events`（type 过滤 / unread_count / evidence 全字段）、`PATCH /me/events/:id/read`（`{read?: boolean}`） |
| 前端 | 见第 6 节（events.astro 真实接线、首页今日事件卡、AppShell 未读角标） |
| 迁移 | **零迁移**（0001 已备齐 alert_events / notification_deliveries / watch_rules 全列） |

## 2. 四门禁

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | **PASS**（全仓 0 错误） |
| `pnpm lint` | **PASS**（0 错误；仅既有 node 20 版本提示） |
| `pnpm test` | **PASS**（apps/api vitest **181 tests / 9 files**，全仓 exit 0） |
| `pnpm -r build` | **PASS**（web + collectors，另含 `PUBLIC_DEMO_DATA=1` 演示构建回归通过） |
| `py -3 -m pytest collectors/tests` | **100 passed**（零 Python 改动） |

apps/api 层（本任务主战场）已先行全绿：`tsc --noEmit`（主 + test tsconfig）、`eslint src`、`vitest run` **181 tests / 9 files**。

## 3. 五场景与状态机结果（vitest `rules-engine.test.ts`，18 项）

| 场景 | 断言要点 | 结果 |
|---|---|---|
| 1 目标价上方 | 不触发、armed 不变 | PASS |
| 2 首次跌破 | 事件落 old/new/target/difference_pct、evidence 含 rule_version/统计日期/质量、armed→triggered、in_app=sent + email=provider_error | PASS |
| 3 持续低于 | triggered 抑制零新增 | PASS |
| 4 回升超缓冲 | hysteresis re-arm 无事件 | PASS |
| 5 再次跌破 | 新 event_key 第二条事件 | PASS |
| 复跑幂等 | event_key UNIQUE 冲突零新增、零重复投递 | PASS |
| 质量门控 | stale 不触发；low_sample 可触发且证据标注「样本不足」 | PASS |
| price_drop 完整链 | 触发→抑制→re-arm→再触发；无窗口基线不触发 | PASS |
| below_comparable 等 | 非本期目标规则跳过（注释留口） | PASS |

口径常量（唯一真源 `rules-engine.ts`）：`TRIGGERABLE_QUALITY = {valid, low_sample}`；`DELAY_SLA_DAYS = {official_index: 45}`、默认 10 天；`ANOMALY_WINDOW_HOURS = 24`。

event_key 设计：规则类 `${rule_id}|${object_type}:${object_id}|${metric_code}|${snapshot_id}`；系统类 `sys|delayed|${watch_id}|${日期}`、`sys|anomaly|${watch_id}|${source_id}|${job_id 或 health|日期}`（含 watch_id 保证多 owner 各自一条、跨日可复产）。

## 4. 系统事件与触发入口

| 项 | 结果 |
|---|---|
| vitest 延迟边界 | SLA 内不产 / 超 SLA 产（滞后天数与 SLA 入证据）/ 零快照 skipped / official_index 45 天 / 同日复跑幂等 |
| vitest 异常归属 | 失败任务按城市匹配双 owner 各一条、城市不匹配不产、健康 down 需城市覆盖、复跑幂等 |
| `POST /internal/events/evaluate` | 签名 → 202 `{delayed, anomaly, skipped}`；复跑计数归零；篡改签名 → 403（`internal.test.ts` 3 项） |
| Worker cron | `wrangler.jsonc` `"triggers": {"crons": ["30 0 * * *"]}`；`index.ts` scheduled 与端点共用 `evaluateSystemEvents`，失败仅 logError |
| 本地手动触发 | `POST /cdn-cgi/local/scheduled` → `ok` |

## 5. 投递占位与故障隔离（验收：邮件 provider 不可用时站内事件保留）

| 注入 | alert_events | in_app 行 | email 行 | 错误消息 |
|---|---|---|---|---|
| sendEmail 抛错（`provider boom recipient@example.test`） | **保留**（created=true） | sent 保留 | `provider_error` / attempt=1 / `last_error_code=provider_error` | **不入库**（测试断言 JSON 不含收件人） |
| 无 provider 接缝（默认） | 保留 | sent | `provider_error` / attempt=0 / `provider_unavailable` | 不入库 |
| 用户 email_enabled=0 | 保留 | sent | 不写 email 行 | — |

本地 e2e 实测投递分布：`in_app/sent 13` + `email/provider_error 13`；生产实测：`in_app/sent 12` + `email/provider_error 12`——**邮件全部如实占位、站内事件一条不少**。

## 6. 前端（Task 5）

改动（仅 `apps/web`，6 文件）：

| 文件 | 交付 |
|---|---|
| `src/lib/api.ts` | `listEvents` / `setEventRead` / `getUnreadEventCount` + 事件类型；401 保留既有跳转、角标场景 401 跳过 |
| `src/lib/events.ts`（新） | 事件级别/中文标签、UTC→Asia/Shanghai 时间格式、样本分层共享映射 |
| `src/components/EventTimelineItem.astro` | data-field、无值块隐藏、quality 透传；演示渲染零变化 |
| `src/pages/events.astro` | 真实分支（limit=50、unread 筛选、PATCH 已读含失败回滚、加载/空态/错误+重试、日期分组、列表与角标双徽标同步）；演示分支移入 else 原样保留 |
| `src/pages/index.astro` | 「今日与我有关」事件卡（当日前 3 条简卡、未登录引导、空态、错误态） |
| `src/layouts/AppShell.astro` | 通知入口红色未读角标（0/401 隐藏），监听 `app:unread-changed` 同步 |

浏览器验收（本地真实链路 4321 astro dev + 18789 wrangler dev，零 mock，17 项断言）：

| 验收项 | 结果与证据 |
|---|---|
| 未登录 401 分支 | **PASS**：首次访问 /events 跳 `/login?next=%2Fevents` |
| 真实事件时间线 | **PASS**：DOM 9 条 = API 9 条；四类中文标签齐 `{目标价首次达成, 窗口期降价, 数据异常, 更新延迟}`；「查看证据」展开 4 行证据 |
| 未读筛选 + 标记已读 + 角标 | **PASS**：`unread=true` 请求、9/9 `data-read=false`；PATCH 后角标 9→8、刷新保持、服务端复核 `unread_count=8 status=read`（验收后已 PATCH `{read:false}` 还原） |
| 首页今日事件卡 | **PASS**：`/` 显示 3 条今日简卡（类型徽标+时间+explanation），全程 `pageerror=[]` |
| 演示模式零回归 | **PASS**：`PUBLIC_DEMO_DATA=1` 构建通过；演示分支原样保留（子代理另以 Playwright+mock 冒烟 50 断言全过，临时脚本已删） |

> 验收环境备注：前端 API base 需与页面同 host（`PUBLIC_API_BASE=http://localhost:18789/api/v1`），否则 `localhost` 域 cookie 不随跨 host fetch 发送；CORS 缺省白名单含 `http://localhost:4321`（`env.ts` DEFAULT_ALLOWED_ORIGINS）。

## 7. API 隔离验收（vitest + e2e 双证）

- vitest：两用户列表互不含、单条读/标记他人 404、无 user_id 入参通道（`/me/*` 只认会话）、非法 type 400、`{read:false}` 标记未读幂等、额外字段 400（`me.test.ts` TASK-05A 3 项）。
- 本地 e2e（18789，23 断言核心 21 通过；2 项为脚本自身断言口径问题，已由补充脚本 8/8 覆盖）：四类事件齐全、A/B 事件 id 集合不相交、B 改 A 事件 404、未登录 401。
- 生产 e2e **26/26 PASS**：真实 API 链路（会话→监控→规则→签名直发→签名 evaluate），A 四类事件（target_price_reached / update_delayed / data_anomaly + price_drop 由直发跌幅批产生于本地）、B 仅自己 4 条、id 不相交、复跑 evaluate 零新增（before=8 after=8）。

## 8. 生产部署与冒烟

| 项 | 结果 |
|---|---|
| `wrangler deploy` | 成功，Version ID `67224861-2ce0-4b9b-9190-d1e88ec59d6e`，`schedule: 30 0 * * *` 已注册 |
| `INGEST_HMAC_SECRET` | 按 04C/04D 先例同会话轮换并双端同步（`wrangler secret put` + `gh secret set`，值仅存 %TEMP%） |
| 签名 evaluate | 202 `{"delayed":1,"anomaly":9,"skipped":3}`；复跑 `{"delayed":0,"anomaly":0}` 幂等 |
| 生产事件分布 | target_price_reached 2 / update_delayed 1 / data_anomaly 9（合计 12） |
| 生产投递分布 | in_app sent 12、email provider_error 12——邮件失败不删站内事件（§8.8/§11） |

## 9. 风险与回滚

- **代码**：`git revert`；Worker `wrangler rollback` 至上一版（67224861 前一版）。
- **cron**：回滚即摘除 triggers；端点路径不受影响。
- **数据**：e2e 种子数据可按 `user_id LIKE 'u_e2e05a%'` / `batch_id='batch_e2e05a*'` / `job_id LIKE 'job_e2e05a%'` 定位清理；无新迁移、无新密钥入仓。
- **投递占位**：email 行 `provider_error` 属如实状态，provider 接线属后续任务；in_app 为唯一真源。
