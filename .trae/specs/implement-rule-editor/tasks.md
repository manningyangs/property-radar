# Tasks

- [ ] Task 1: 共享规则模板与绑定校验（packages/shared）
  - [ ] SubTask 1.1: `RULE_TEMPLATES`——5 种 rule_type 的 label、object_types、metrics（metric_code/price_type/unit 三元组）、字段策略（target/threshold/window 的 required|optional|forbidden）
  - [ ] SubTask 1.2: `validateRuleBinding(input, object_type): string[]`——枚举/对象匹配/指标绑定/单位一致/字段策略逐项产出中文错误信息（官方指数、小区中位价互比等验收场景须有专属文案）
  - [ ] SubTask 1.3: shared 测试——每类型合法绑定通过；验收两类反例 + 单位错配 + 字段策略反例被拒；未知 rule_type/metric_code 被拒
- [ ] Task 2: 数据库迁移 0004 —— 规则设置侧表
  - [ ] SubTask 2.1: `db/migrations/private/0004_watch_rule_settings.up.sql`/`down.sql`（IF NOT EXISTS / DROP IF EXISTS 幂等；rule_id PK→watch_rules FK ON DELETE CASCADE、user_id→users、valid_until TEXT 可空、三 notify 布尔 CHECK、updated_at）
  - [ ] SubTask 2.2: `packages/migrations/src/index.test.ts` 的 `PRIVATE_TABLES` 15→16，补断言：up 重复执行幂等、down 干净、删除 watch item / rule 时 settings 级联消失、notify 布尔 CHECK 生效
- [ ] Task 3: API schema 与规则路由（apps/api）
  - [ ] SubTask 3.1: `schemas.ts`——`rule_type` 收紧为 5 枚举；RULE_PROPERTIES 新增 `valid_until`（`["string","null"]` + `^\d{4}-\d{2}-\d{2}$`）、`notify_email`/`notify_digest`/`notify_inapp`（boolean）；确认全部关键字在 validation.ts 白名单内
  - [ ] SubTask 3.2: POST `/me/watch-items/:id/rules`——加载父对象 object_type → `validateRuleBinding`（400 errors.validation，字段路径规范）→ 写 watch_rules + watch_rule_settings（渠道默认全开）
  - [ ] SubTask 3.3: PATCH `/me/rules/:id`——JOIN watch_items 取 object_type；内容字段变更时按合并态重校验并 `version+1`；is_enabled 启用时重置 `armed_state='armed'`（不递增 version）；valid_until/notify_* 写侧表；渠道全关 → 400
  - [ ] SubTask 3.4: GET 规则列表与单条响应——LEFT JOIN/读取侧表合并（缺行默认渠道全开、有效期 null），计算 `is_expired`
  - [ ] SubTask 3.5: GET `/me/watch-items`——批量聚合 `enabled_rule_count` + `rule_highlight`（≤1 条附加 SQL，禁 N+1）
- [ ] Task 4: API 测试
  - [ ] SubTask 4.1: 绑定校验——验收两场景（listing×community_unit_price_lte 400、official_price_index×元/㎡ 400）+ 单位错配 + 字段策略（跌幅带 target、缺 target）400
  - [ ] SubTask 4.2: 有效期/渠道——valid_until 往返与 is_expired 两态、非法日期 400、渠道全关 400、缺行旧规则默认全开
  - [ ] SubTask 4.3: 触发状态与版本——启用重置 armed_state、启停不递增 version、改 target_value version+1、armed_state 不接受客户端直写
  - [ ] SubTask 4.4: 数据隔离与级联——跨用户 GET/PATCH/DELETE 规则 404；删规则/删对象后 watch_rule_settings 无残留
  - [ ] SubTask 4.5: 卡片聚合——enabled_rule_count/rule_highlight 正确（含无规则 null）、既有测试全绿
- [ ] Task 5: 前端 API 客户端（apps/web/src/lib/api.ts）
  - [ ] SubTask 5.1: `Rule`/`RuleInput`/`RulePatch` 类型（含 valid_until、notify_*、is_expired、armed_state、version、rule_highlight/enabled_rule_count 并入 WatchItem）
  - [ ] SubTask 5.2: `listRules`/`createRule`/`patchRule`/`deleteRule`（错误信封解析与 401→登录复用现有 ApiError 基建）
  - [ ] SubTask 5.3: `apps/web/package.json` 增加 `"@property-radar/shared": "workspace:*"`，pnpm install（--no-frozen-lockfile）确认 Astro 可解析 TS 源码包
- [ ] Task 6: rules.astro 真实接线（演示分支原样保留）
  - [ ] SubTask 6.1: 真实分支数据流——401→`/login?next=/rules`；`listWatchItems` 选对象（`?watch=` 预选）；region 对象规则类型全禁用并注明"区域规则待指标接入"
  - [ ] SubTask 6.2: 编辑表单——规则类型按 object_type 过滤；指标/口径/单位由 RULE_TEMPLATES 自动绑定只读展示；按字段策略显隐目标价/跌幅阈值/窗口；re-arm 缓冲、有效期（date，可清空）、渠道三勾选（≥1 前端预检）
  - [ ] SubTask 6.3: 列表与操作——规则卡片（条件文案、启用/停用、已过期徽标、渠道徽标、armed_state 展示）、创建/编辑提交、删除走确认弹窗；400/409 错误信封映射友好文案
- [ ] Task 7: watch 卡片回填（watch/index.astro）
  - [ ] SubTask 7.1: 模板"目标值"渲染 rule_highlight（单价 `≤ 20,500 元/㎡`、跌幅 `跌幅 ≥ 5%` 形态；null → "—"）；规则状态行按 enabled_rule_count/对象类型显示"已启用 N 条规则 / 未设置规则 / 区域规则待指标接入"，替换"待后续任务接入"占位文案
  - [ ] SubTask 7.2: 新增"编辑规则"按钮 → `/rules?watch=<watch_id>`；最新值/价差保持"—"不造数
- [ ] Task 8: 四门禁与浏览器验证
  - [ ] SubTask 8.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿
  - [ ] SubTask 8.2: 浏览器验证（真实模式，本地 private D1 直插会话）：创建目标单价规则 → 列表出现 → watch 卡片目标值回填 → 编辑改价 version+1（响应可见）→ 渠道/有效期编辑 → 停用/启用 → 删除确认；演示模式行为与 01B 一致；验收场景在 API 测试兜底
- [ ] Task 9: 提交与 CI
  - [ ] SubTask 9.1: 中文 commit `TASK-03B: …` → push → 盯 CI 至绿
  - [ ] SubTask 9.2: §12.0 收尾报告（改动摘要/文件/测试/风险/回滚）→ 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 1] 独立先行（Task 3/6 都依赖模板与校验函数）
- [Task 2] 独立，可与 Task 1 并行
- [Task 3] depends on [Task 1, 2]
- [Task 4] depends on [Task 3]（可与 Task 5/6 并行开发，最后合跑）
- [Task 5] depends on [Task 3]（契约定型；类型对齐可与 Task 4 并行）
- [Task 6 / Task 7] depends on [Task 5]（相互独立可并行）
- [Task 8] depends on [Task 4, 6, 7]
- [Task 9] depends on [Task 8]
