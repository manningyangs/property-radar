# Checklist

## API 与数据

- [x] POST/PATCH 规则按 object_type + RULE_TEMPLATES 交叉校验，非法返回 400 `errors.validation`
- [x] 验收场景 1：listing×community_unit_price_lte（或小区中位价指标挂房源）→ 400；community×listing_total_price_lte → 400
- [x] 验收场景 2：official_price_index + 元/㎡ → 400，文案指明官方指数口径
- [x] 单位与指标口径一致（community_ask_median_unit 必须元/㎡、listing_ask_total 必须元），错配 → 400
- [x] 字段策略：lte 类必填 target_value>0 且禁 window/threshold；price_drop_pct 必填 threshold_pct+window_days 禁 target_value；below_comparable_median_pct 必填 threshold_pct 禁 target_value
- [x] `valid_until` 存取往返（YYYY-MM-DD / null），`is_expired` 按当天日期两态正确，非法日期 400
- [x] 每规则三渠道 notify_* 存取往返，全关 → 400；旧规则缺 settings 行按默认全开返回
- [x] 启用规则重置 `armed_state='armed'`；启停不递增 version；内容字段 PATCH → version+1
- [x] `armed_state` 不接受客户端直写（PATCH 忽略/拒绝该字段）
- [x] 迁移 0004 幂等（up 重复执行）、down 干净；PRIVATE_TABLES=16；notify 布尔 CHECK 生效
- [x] 删除规则 / 删除 watch item → watch_rule_settings 行级联消失
- [x] 数据隔离：跨用户 GET/PATCH/DELETE 规则 → 404
- [x] `GET /me/watch-items` 返回 `enabled_rule_count`、`rule_highlight`，批量聚合无 N+1
- [x] 既有测试全部保持通过（api / migrations / shared）

## 前端

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 四门禁全绿
- [x] rules.astro 演示模式分支行为与 01B 一致（DEMO 标签）
- [x] 真实模式未登录访问 /rules → 跳 `/login?next=%2Frules`
- [x] 选对象后规则类型按 object_type 过滤；region 全禁用并注明"区域规则待指标接入"
- [x] 指标/口径/单位由模板绑定且只读展示，用户不可自改
- [x] 表单按字段策略显隐目标价/跌幅阈值/窗口；渠道 ≥1 前端预检；有效期可设可清
- [x] 创建 → 列表出现 → 编辑（改价可见 version 变化）→ 启停 → 删除确认，全走真实 API
- [x] watch 卡片：目标值按 rule_highlight 渲染真实数值；规则状态行三态（N 条/未设置/区域待接入）；"编辑规则"跳 `/rules?watch=`；最新值/价差保持"—"
- [x] 400/401/409 错误信封映射友好文案

## 合规与流程

- [x] 产物无真实 token/验证码/邮箱；演示数据带 DEMO 徽标
- [x] 中文 commit `TASK-03B: …` → push → CI 绿
- [x] §12.0 收尾报告输出（改动摘要/文件/测试/风险/回滚），记忆 topics.md / project_memory.md 更新
