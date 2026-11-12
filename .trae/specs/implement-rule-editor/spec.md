# TASK-03B 规则编辑器 Spec

> PRD 任务书 V1.2 · 任务行 1262–1266 · 关联 §4.2 指标范围 / §4.6 目标价规则 / §2.6 添加监控 / §2.7 监控列表 / §9.2 watch_rules / §10.3 用户 API
> 备份 tag：`pre-v1-p2-task-03b`（指向 e3e1dfc，工作区干净）
> 交付范围（用户已确认）：**API + 前端 + 接线**，含把 03A 在 watch 卡片留的目标价/规则占位替换为真实规则数据
> 通知偏好粒度（用户已确认）：**每规则独立渠道开关**（触发邮件 / 每日摘要 / 站内事件），与已有用户级 /me/notification-preferences 并存

## Why

02B 已交付 watch_rules 的基础 CRUD（[me.ts](file:///e:/desktop/home_search/apps/api/src/routes/me.ts) L386–521），但 `rule_type` 是自由字符串、`metric_code`/`price_type`/`unit` 之间零校验——用户可以给小区挂"房源总价"规则、把官方指数当元/㎡目标价（PRD 03B 验收明确禁止的两种情况）；有效期与每规则通知偏好完全没有存储；`version` 修改目标价不递增，03C 引擎需要的"规则版本留存"无从谈起；前端 [rules.astro](file:///e:/desktop/home_search/apps/web/src/pages/rules.astro) 是纯本地演示（01B），与 API 零连接，03A 在 watch 卡片上留的目标价占位"—"也无人填充。

## What Changes

- **共享规则模板**：`packages/shared` 新增 `RULE_TEMPLATES`（5 种规则类型 → 允许的 object_type、metric_code/price_type/unit 绑定、字段策略 required/optional/forbidden）与 `validateRuleBinding()` 纯函数；`apps/web` 新增对 `@property-radar/shared` 的 workspace 依赖，前后端共用同一份绑定矩阵。
- **数据库迁移 0004**：新表 `watch_rule_settings`（rule_id PK → watch_rules FK 级联、user_id、`valid_until` YYYY-MM-DD 可空、`notify_email`/`notify_digest`/`notify_inapp` 三布尔、updated_at）；`PRIVATE_TABLES` 15→16。**不 ALTER watch_rules**（SQLite ADD COLUMN 非幂等，与 0003 同策略用新表）。
- **API 校验**：`schemas.ts` 的 `rule_type` 收紧为 5 枚举；新增 `valid_until`（日期 pattern 或 null）、`notify_*` 布尔字段。POST/PATCH 在应用层用 `validateRuleBinding` 按父 watch_item 的 `object_type` 做语义交叉校验（schema 关键字全部在 validation.ts 白名单内，无需扩解释器）。
- **API 行为**：POST 创建时同步写 settings 行（渠道默认全开）；PATCH 内容字段（口径/目标/阈值/窗口/hysteresis）变更时 `version+1`，渠道/有效期/is_enabled 变更不递增；启用规则（is_enabled false→true）时 `armed_state` 重置为 `armed`；GET 规则列表合并 settings（缺行按默认全开）并计算 `is_expired`。
- **watch 列表**：`GET /me/watch-items` item 扩展 `enabled_rule_count` 与 `rule_highlight`（已启用规则中最新一条的摘要，批量聚合禁 N+1）。
- **前端**：`src/lib/api.ts` 新增 Rule 类型与 listRules/createRule/patchRule/deleteRule；`rules.astro` 真实分支（演示分支原样保留）——选监控对象 → 按对象类型过滤规则类型 → 指标/口径/单位由模板自动绑定只读展示 → 目标价/跌幅阈值/窗口/有效期/re-arm 缓冲/渠道勾选 → 创建/编辑/启停/删除；`watch/index.astro` 卡片填目标值与规则状态、新增"编辑规则"入口指向 `/rules?watch=<id>`。
- **BREAKING**：`rule_type` 由自由字符串收紧为 5 枚举（此前无 UI 能创建任意规则，实际影响为旧手工测试数据不再能 PATCH 内容字段，可删除重建）；`GET /me/watch-items` 响应仅增字段，向后兼容。

## Impact

- Affected specs: 规则编辑器（03B）、监控对象管理（03A 卡片占位回填）、价格规则引擎（03C 将消费 version/armed_state/valid_until）
- Affected code:
  - `packages/shared/src/index.ts` + `index.test.ts`（RULE_TEMPLATES、validateRuleBinding）
  - `packages/migrations/src/index.test.ts`（PRIVATE_TABLES 16）
  - `db/migrations/private/0004_watch_rule_settings.{up,down}.sql`
  - `apps/api/src/schemas.ts`、`apps/api/src/routes/me.ts` 及 api 测试
  - `apps/web/package.json`（依赖 @property-radar/shared）、`src/lib/api.ts`、`src/pages/rules.astro`、`src/pages/watch/index.astro`
- 无需改动：`apps/api/src/validation.ts`（所需关键字已在白名单）、`.env.example`、`.gitignore`

## ADDED Requirements

### Requirement: 规则类型与指标绑定校验

系统 SHALL 在创建/修改规则时按 `RULE_TEMPLATES` 校验：`rule_type` 仅允许 `community_unit_price_lte`、`listing_total_price_lte`、`listing_unit_price_lte`、`price_drop_pct`、`below_comparable_median_pct`；`rule_type` 与父监控对象 `object_type` 匹配；`metric_code`+`price_type`+`unit` 三元组必须取模板绑定值（单价口径=元/㎡、总价口径=元、百分比规则不得带 target_value/unit）；任一不符返回 400 `errors.validation`。区域对象暂不支持建规则（无区域级 metric_code，规则类型下拉禁用并注明原因）。

#### Scenario: 不允许小区中位价与房源总价互比

- **WHEN** 对 listing 对象 POST `rule_type=community_unit_price_lte`（或 metric_code=community_ask_median_unit），或对 community 对象 POST `listing_total_price_lte`
- **THEN** 返回 400，错误信息指明规则类型与对象/指标不匹配

#### Scenario: 官方指数不得作为元/㎡目标价

- **WHEN** POST 任意规则携带 `metric_code=official_price_index` 且 `unit=元/㎡`
- **THEN** 返回 400，错误信息指明官方指数口径不支持该单位/规则类型

#### Scenario: 单位必须与指标口径一致

- **WHEN** `metric_code=community_ask_median_unit` 而 `unit=元`（总价单位）
- **THEN** 返回 400，错误信息给出该指标要求的正确单位

### Requirement: 有效期与通知渠道存储

系统 SHALL 通过 0004 侧表 `watch_rule_settings` 支持每条规则的 `valid_until`（`YYYY-MM-DD`，null=长期有效）与 `notify_email`/`notify_digest`/`notify_inapp` 三个渠道开关；规则读取时合并返回并计算 `is_expired`（valid_until 早于今天）；渠道至少保留一个开启（全关→400）；缺 settings 行的旧规则按渠道全开、无有效期返回。

#### Scenario: 设置与清除有效期

- **WHEN** 创建规则时带 `valid_until=2027-01-01`，之后 PATCH `valid_until=null`
- **THEN** 往返正确，`is_expired` 按当天日期计算为 false；设为过去日期则 `is_expired=true`

#### Scenario: 渠道至少一项

- **WHEN** PATCH 把三个 notify 开关全部置 false
- **THEN** 返回 400 `errors.validation`

#### Scenario: 删除级联

- **WHEN** 删除规则或删除所属监控对象
- **THEN** `watch_rule_settings` 对应行随 FK 级联消失，无孤儿残留

### Requirement: 触发状态与 re-arm 阈值

系统 SHALL 在规则响应中返回 `armed_state`（读取时展示，03B 不允许客户端直接改写状态机）；`hysteresis_pct`（re-arm 缓冲幅度，0–100）可编辑、可空；`is_enabled` 关→开时系统 SHALL 将 `armed_state` 重置为 `armed`（重新布防）；规则内容字段（口径/目标/阈值/窗口/hysteresis）PATCH 时 `version` 递增 1，渠道/有效期/is_enabled 变更不递增。

#### Scenario: 启用即重新布防

- **WHEN** 用户停用一条 `armed_state=triggered`（或 armed）的规则后再次启用
- **THEN** `armed_state` 回到 `armed`，`version` 不因启停变化

#### Scenario: 修改目标价保留版本计数

- **WHEN** PATCH `target_value`
- **THEN** 响应 `version` 比修改前 +1（03C 规则版本留存以此为锚）

### Requirement: 字段级输入策略（每类型）

系统 SHALL 按模板字段策略校验：lte 类规则 `target_value` 必填且 >0、`window_days`/`threshold_pct` 禁止；`price_drop_pct` 必填 `threshold_pct`（0<x≤100）与 `window_days`（1–3650）、禁止 `target_value`；`below_comparable_median_pct` 必填 `threshold_pct`、禁止 `target_value`；不符返回 400。

#### Scenario: 跌幅规则不带目标价

- **WHEN** POST `rule_type=price_drop_pct` 携带 `target_value=20000`
- **THEN** 返回 400 `errors.validation`

#### Scenario: 目标单价规则必填目标值

- **WHEN** POST `rule_type=community_unit_price_lte` 缺 `target_value`
- **THEN** 返回 400，指明缺少目标单价

### Requirement: watch 卡片规则数据回填

系统 SHALL 在 `GET /me/watch-items` 每个 item 返回 `enabled_rule_count`（已启用规则数，批量聚合 ≤1 条附加 SQL）与 `rule_highlight`（最新已启用规则的 rule_type/metric_code/price_type/target_value/unit/threshold_pct，无则 null）；前端卡片"目标值"与规则状态行由其渲染，"编辑规则"入口跳 `/rules?watch=<watch_id>`；最新值/价差仍留"—"（价格快照展示属数据接入任务，不造数）。

#### Scenario: 有规则的卡片

- **WHEN** 用户对象存在 1 条启用的目标单价规则，打开 /watch
- **THEN** 卡片目标值显示 `≤ 20,500 元/㎡` 形态的真实数值，规则状态行显示已启用规则数

#### Scenario: 无规则与区域对象

- **WHEN** 对象无启用规则
- **THEN** community/listing 卡片显示"未设置规则"，region 卡片显示"区域规则待指标接入"，目标值"—"

### Requirement: 规则编辑器前端真实接线

系统 SHALL 在演示模式关闭时：未登录跳 `/login?next=/rules`；选定监控对象后按 `object_type` 过滤可选规则类型（region 全部禁用并注明"区域规则待指标接入"，listing 对象在 watch/add 禁用的提示不适用——此处 listing 无数据来源限制，允许创建规则）；指标/口径/单位由模板自动绑定并以只读方式展示（用户不可改绑定）；表单按字段策略动态显隐目标价/跌幅阈值/窗口；提交走 POST/PATCH，409/400 错误信封映射友好文案；启停、删除（确认弹窗）、渠道与有效期编辑全部走真实 API；`?watch=` 参数预选对象。

#### Scenario: 真实创建规则全流程

- **WHEN** 登录用户在 /rules 选择小区对象 → 规则类型"小区挂牌单价 ≤ 目标价" → 输入目标单价与渠道 → 保存
- **THEN** POST 成功返回 201，列表出现该规则卡片，watch 卡片目标值同步变化

#### Scenario: 前端预检与后端一致

- **WHEN** 用户在房源对象上试图构造超出模板的指标组合（通过类型切换）
- **THEN** 表单只展示模板允许的组合，即使绕过前端直接 POST 也被后端 400 拦截

## MODIFIED Requirements

### Requirement: watch-rules API 请求/响应

`createRuleSchema`/`patchRuleSchema`：`rule_type` 由自由字符串改为 5 枚举；新增 `valid_until`（`YYYY-MM-DD` pattern 或 null）、`notify_email`/`notify_digest`/`notify_inapp`（boolean）；`GET /me/watch-items/:id/rules` 与 `POST`/`PATCH` 响应 item 增加 `valid_until`、三个 notify 字段、`is_expired`；其余既有字段与错误信封保持不变（向后兼容）。

### Requirement: 监控列表响应

`GET /me/watch-items` item 增加 `enabled_rule_count`、`rule_highlight`（仅新增字段，既有 `group_name`/`auto_monitoring` 行为不变）。

## REMOVED Requirements

（无）
