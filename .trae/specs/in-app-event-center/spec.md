# SPEC: TASK-05A 站内事件中心

> PRD 任务书 V1.2 · 任务行 1322–1326 · 关联 §2.8 事件中心 / §4.6 目标价规则 / §4.7 数据质量状态 / §6.6 定时任务 / §7.2 通知渠道 / §7.3 立即提醒含义 / §7.4 权限与隔离 / §8.8 邮件和事件投递 / §9.2 alert_events+notification_deliveries / US-07·US-08 / §11（邮件失败站内事件保留）

## 0. 用户已拍板的四项范围决策（2026-11-13）

1. **事件生成 = 并入 TASK-03C 核心**：05A 内实现快照入库后的规则比对（目标价首次达成、窗口期降价两类事件；幂等 event_key、armed/triggered 状态机、re-arm、质量门控），并补齐 03C 验收要求的五场景自动化测试（目标价上方、首次跌破、持续低于、回升、再次跌破）。可比价规则（below_comparable_median_pct）本期不评估。
2. **系统事件按 watch 对象生成**：数据源超 SLA 未更新 → 持有该对象监控的用户各一条「更新延迟」；采集任务失败/来源健康 down → 对应 watch 用户各条「数据异常」。按 user+object+日期幂等去重，只影响持有相关监控的用户；不做全局复制，也不做查询时物化。
3. **投递占位 + 故障注入**：事件创建时写 `notification_deliveries` 的 in_app 投递行；email 投递行如实落 `provider_error`（05A 不发邮件，绝不谎称已发送）。测试注入 provider 抛错，断言 alert_events 行保留、接口与页面正常，05B 在同一投递点接真实发送。
4. **前端 = 事件中心 + 首页卡 + 未读徽标**：events.astro 真实接线（登录态、筛选、标记已读/未读、证据明细、未读数）+ 首页「今日与我有关」事件卡 + AppShell 通知入口未读角标；演示分支原样保留。

## 1. 背景与现状（调研结论）

- **已有底座（不重复造）**：
  - `alert_events` 表（Private 0001）：event_key UNIQUE 幂等键、evidence_json、old/new/target_value、difference_pct、read_at/status，`ix_alert_events_user_created`；`notification_deliveries` 表（channel/provider/status/attempt_count/last_error_code，注释明确「邮件失败不删除站内事件」）。
  - `GET /me/events`（unread/limit 过滤）与 `PATCH /me/events/:id/read`（幂等已读）已实现且带 user_id 隔离（[me.ts](file:///e:\desktop\home_search\apps\api\src\routes\me.ts#L807-L869)）。
  - 03B 规则 CRUD：`watch_rules` 五类模板 + `armed_state`/`version`/`hysteresis_pct`/`window_days`/`threshold_pct` 全列齐备，代码注释明确「状态机本体属 03C」；`watch_rule_settings` notify 三布尔（0004 侧表）。
  - `price_snapshots.snapshot_id` 为确定性 sha256（键含 object/price_type/metric/stat_date），可直接作 event_key 组成。
  - 前端脚手架：events.astro（演示分支完整：筛选/未读统计/时间线）、EventTimelineItem（PRD 2.8 字段全集+证据展开+已读切换）、index.astro「今日与我有关」区块、AppShell 通知入口。
- **缺口（本任务新代码）**：
  - **全仓无任何生产代码写入 `alert_events`**——TASK-03C 规则引擎从未实施（tag 03b 直接跳 04a），目标价/降价事件没有生成来源；
  - 数据异常、更新延迟两类系统事件无判定逻辑、无触发入口（无 Worker cron）；
  - email 投递无占位状态，「邮件失败事件保留」无任何测试锁定；
  - events.astro 真实模式是空态占位，未接 API；首页事件卡与未读角标仅演示数据。

## 2. 需求（In Scope）

### R1 规则引擎（并入 03C 核心，服务端唯一实现点）

**新模块 `apps/api/src/rules-engine.ts`**（时钟 `now` 可注入；被 internal 批次与 admin 补录共用）：

1. **触发点**：`writeObservations()` 返回 `snapshots_upserted > 0` 之后、同一请求内调用 `evaluateRulesForObjects(env, objectIds, now)`，只评估本批受影响对象的规则（`watch_items` 按 object_type+object_id 反查，跨库：Public 快照 ↔ Private 规则）。`POST /internal/ingest/batch` 与 `POST /admin/observations` 两条路径都接。
2. **质量门控（§4.7）**：仅对 `quality_status ∈ {valid, low_sample}` 的新快照运行——PRD 显式排除 `stale/outlier/rejected/uncovered`（uncovered=无快照天然不触发）；`low_sample` 允许触发但 evidence 标注质量等级（US-07「质量合格」以 PRD 4.7 排除清单为准）。
3. **规则范围**：
   - 目标价类 `community_unit_price_lte` / `listing_unit_price_lte` / `listing_total_price_lte`：当前快照 median（按 metric 映射）≤ target_value 触发；
   - 降幅类 `price_drop_pct`：窗口 `window_days` 内最早有效快照 median 与当前比较，跌幅 ≥ `threshold_pct` 触发（窗口内无更早快照则不触发）；
   - `below_comparable_median_pct`：**本期跳过不评估**（可比组数据未接入，不报错、不落痕，注释说明）。
4. **armed/triggered 状态机（§4.6-4/5）**：
   - `armed` 且条件满足 → 生成事件 + `armed_state='triggered'`；
   - `triggered` 且条件持续满足 → **不重复生成**；
   - `triggered` 且价格回到目标上方超过缓冲：`value > target × (1 + hysteresis_pct/100)`（`hysteresis_pct` NULL 视为 0）→ 回 `armed`（无事件）；跌幅类同理：窗口跌幅回落到 `threshold_pct − hysteresis_pct` 以下才重新布防；
   - 回 `armed` 后再次满足 → 新事件（对应 03C「再次跌破」场景）。
5. **幂等与版本留存（§4.6-3/6）**：
   - `event_key = ${rule_id}|${object_type}:${object_id}|${metric_code}|${snapshot_id}`，UNIQUE 冲突静默跳过（批次复跑/重复评估零新增）；
   - `evidence_json` 落：规则 `version`、触发时 `target_value/threshold_pct`、`stat_date`、`source_id`、`sample_count`、`quality_status`、窗口明细（跌幅规则含窗口起止值）——历史事件不受后续改目标价影响；`old_value/new_value/target_value/difference_pct` 落列。
   - 事件类型枚举（本任务四类）：`target_price_reached`（目标价首次达成）、`price_drop`（窗口期降价）、`data_anomaly`（数据异常）、`update_delayed`（更新延迟）。

### R2 系统事件：数据异常与更新延迟（按 watch 对象归属）

**同模块 `evaluateSystemEvents(env, now)`**：

1. **归属**：取全体 `status='active'` 的 watch_items，按 (object_type, object_id) 去重评估；命中后为该对象的**每个 owner 用户**各写一条（跨库无 JOIN，先 Public 查对象维度再 Private 按 object 反查用户）；无规则的监控对象同样生成（系统事件与规则无关）。
2. **update_delayed 判定**：对象最新快照 `stat_date < 当日 − DELAY_SLA_DAYS[price_type]` → 一条。SLA 常量集中导出：`official_index = 45` 天（月度来源，次月末前应更新）、其余 = `10` 天；**零快照（未覆盖）对象不生成延迟事件**（uncovered ≠ 延迟，避免噪音）。`event_key = sys|delayed|${watch_id}|${Asia/Shanghai 当日}`——`event_key` 全表 UNIQUE，须含 watch_id（每用户每对象每日最多一条，持续延迟不刷屏；规则类事件的 user 隔离由 rule_id 天然携带）。
3. **data_anomaly 判定**（近 24 小时窗口）：
   - `ingest_jobs.status='failed'` 且 job 的 (source_id, city_code) 覆盖该对象所在城市；或
   - 该对象城市覆盖来源的最新 `source_health_reports.status='down'`；
   - `event_key = sys|anomaly|${watch_id}|${source_id}|${job_id 或当日}`（含 watch_id 保证跨用户唯一，同上）。
   - 对象→城市跨库解析：community/listing 查 Public `communities`，region 用自身 city_code；城市×来源查 `source_city_coverage`。
   - **如实说明**：04E 极端值 400 不入库、rejected 行不可达，故异常判定以任务失败/来源健康为准，不以快照 quality 行为源（写入本节注释）。
4. **触发入口（双入口同一函数）**：
   - `POST /internal/events/evaluate`：复用既有 HMAC 签名链（internal.ts verifySignedRequest），body 允许空对象，返回 `{delayed, anomaly, skipped}` 计数——供采集后调用、生产验收与 CI 手动触发；
   - Worker `scheduled` 处理器 + `wrangler.jsonc` 触发器 `crons: ["30 0 * * *"]`（UTC 00:30 = 北京 08:30，对齐 §6.6「08:00 健康检查」精神），调用同一函数。
5. **延迟/异常事件字段**：rule_id NULL、watch_id 落该 owner 的 watch_id、old/new/target NULL、evidence_json 落 SLA 值/最新 stat_date 或 job_id/error_code/来源名、解释文本所需数据齐全。

### R3 投递占位与故障隔离（验收核心）

1. **创建后分发**：`createEvent()` 写入 alert_events 成功后调用 `dispatchNotification(env, event, now)`，**try/catch 全包裹**——分发失败绝不影响已写事件：
   - `channel='in_app'` 行：`status='sent'`、`sent_at=now`（站内事件即投递本体）；
   - `channel='email'` 行：当用户 `notification_preferences.email_enabled=1` 且（规则未绑 notify 或 `watch_rule_settings.notify_email=1`）时写行；05A 未接邮件发送 → `provider='apps_script'`、`status='provider_error'`、`last_error_code='provider_unavailable'`、`attempt_count=0`（§8.8/§11：不得显示「邮件已发送」）；05B 在此函数同一位置接 `GoogleAppsScriptMailProvider` 真实发送。
2. **故障注入测试**：测试桩让 provider 调用点抛异常 → 断言：alert_events 行数不变、in_app 行完好、email 行 `status ∈ {provider_error, pending 之外}` 恒非 sent、`GET /me/events` 正常返回、页面正常渲染。
3. **解耦断言**：引擎与分发模块不 import 任何真实邮件网络调用（05A 期），事件写入先于分发——邮件路径任何故障（未配置、抛错、超时）都无法回滚事件。

### R4 API 扩展与隐私隔离（§7.4）

1. `GET /me/events`：增 `type` 过滤（四类枚举 + 缺省全部，非法 400）；响应增 `unread_count`（当前用户未读总数，不受 limit 影响）；items 补齐 §2.8 字段——`event_type`、`evidence`（evidence_json 解析，损坏回 `{}`）、`snapshot_id`、`difference_pct` 等全列返回；排序 `created_at DESC`，limit 沿用 1–50。
2. `PATCH /me/events/:id/read`：body 扩为 `{read?: boolean}`——`true`/缺省 = 标记已读、`false` = 标记未读（前端「标记未读」需要）；幂等；schema 仍 `additionalProperties:false`。
3. **隔离红线**：全部查询/更新强制 `WHERE user_id = 柋试话解析值`；不接受客户端传 user_id；他人事件列表不可见、单条读/标记一律 404（「事件不存在」与不存在同文案，不泄露存在性）。
4. 隐私最小化：事件与证据不含邮箱/IP；公开接口零事件数据（`public.test.ts` 既有 SQL 注入词表回归覆盖）。

### R5 前端真实接线（拍板 4；演示分支原样保留）

1. **events.astro 真实分支**：
   - 未登录 401 → `/login?next=/events`（复用 api.ts 既有拦截）；
   - `GET /me/events` 渲染时间线：EventTimelineItem 字段映射——级别 `target_price_reached→高`、`price_drop/data_anomaly→中`、`update_delayed→低`；对象名、触发前后值、价差（direction/deltaAmount/deltaPct）、数据日期/来源/样本量/质量、解释文本、证据列表全部来自 API 字段（evidence_json），不前端造数；
   - 筛选 全部/未读/已读（沿用既有 query 参数，真实数据切换）；标记已读/未读调 API 成功后更新条目、未读徽标与角标；证据展开沿用组件内交互；
   - 状态齐全：加载中、空态（区分「无事件」与「未覆盖」文案）、错误态（PRD 2.2A）。
2. **首页「今日与我有关」真实卡**：登录态取 `created_at` 为 Asia/Shanghai 当日的事件 top 3（可由 GET /me/events 返回内客户端过滤，或加 `today=true` 查询参数——实施期取简者，spec 以「首页只展示今日真实事件」为准）；空态与未登录引导；演示分支保留。
3. **AppShell 通知入口未读角标**：登录态拉 `unread_count`，>0 显示红色角标（隐藏零值）；事件页内已读后角标同步减少。
4. 演示模式（`PUBLIC_DEMO_DATA=1`）全部既有行为不回归。

### R6 回归、门禁与边界

- 全量回归：既有 vitest（清洗/批次/规则 CRUD/公开面）+ pytest 100 项 + 四门禁（typecheck/lint/test/-r build）。
- **Out of Scope**：邮件实际发送与每日摘要（05B）、浏览器推送（05C）、below_comparable_median_pct 评估、事件导出与管理后台（06D）、微信等其他通道、事件分页游标（沿用 limit≤50）。
- **零迁移承诺**：05A 不新增数据库迁移（0001 已备齐全部所需列与索引）；若实施期确需新字段，以新表侧挂（0003/0004 先例：不 ALTER 既有表）并回写本 spec 偏差说明。

## 3. 验收标准 → 映射

| PRD 05A 目标/验收 | 达成方式 |
|---|---|
| 展示目标价事件 | R1 状态机 + `target_price_reached` + 五场景自动化测试 |
| 展示降价事件 | R1 `price_drop` 窗口跌幅 + armed 抑制重复 |
| 展示数据异常、更新延迟事件 | R2 按 watch 对象生成 + 每日幂等去重 + 双入口触发 |
| 验收：邮件 provider 不可用时站内事件依然保留 | R3 故障注入（provider 抛错/未配置）→ 事件与 in_app 行保留、email 行 provider_error 非 sent；生产冒烟同样断言 |
| 验收：用户只能访问自己的事件 | R4 隔离测试：两用户列表互不含、单条 GET/标记他人 404、无 user_id 入参通道 |
| 事件字段全集（§2.8） | R1/R2 evidence_json + R4 全列返回 + R5 逐字段渲染 |
| 邮件失败不删事件（US-08/§11） | R3 解耦顺序（事件先写、分发 try/catch） |
| 03C 移交：幂等、事件唯一、重复抑制、质量门控、规则版本留存 | R1-2/4/5 全部以测试锁定 |

## 4. 风险与回滚

- **事件噪音**：延迟/异常按对象×日去重；SLA（45/10 天）与 24h 窗口集中常量，调参即生效；零快照对象不产延迟事件。上线首日 cron/手动 evaluate 可能对存量老数据对象产生一批真实延迟事件——属如实展示，验收报告记录数量。
- **评估成本**：试点规模 watch 数量小，全量 active watch 遍历 + 每对象 1–2 条查询可接受；不引入分页/队列。
- **状态机正确性**：armed/triggered 并发写以单请求串行评估 + event_key UNIQUE 兜底（D1 单写者），复跑幂等由 UNIQUE 测试锁死。
- **回滚**：代码 `git revert`；**无迁移**；`wrangler.jsonc` cron 触发器随 revert 移除（`wrangler deploy` 后生产 cron 同步消失）；已生成事件/投递行可按 `event_type LIKE 'sys|%'` 或验收日期 DELETE（生产任务测试数据按 PRD 保留）。无新密钥、无新付费依赖。
