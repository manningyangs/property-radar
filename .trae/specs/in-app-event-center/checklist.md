# Checklist — TASK-05A 站内事件中心

## 验收清单（PRD 任务行 1322–1326）

- [x] 目标价事件可展示：规则首次满足生成 `target_price_reached`，含触发前后值、价差、目标值、数据日期、来源、样本量、质量、解释与证据（§2.8 字段全集）
- [x] 降价事件可展示：`price_drop_pct` 窗口跌幅达阈值生成 `price_drop`，窗口明细入证据
- [x] 数据异常事件可展示：近 24h 采集任务失败/来源健康 down → 覆盖该对象城市的 watch 用户各一条 `data_anomaly`
- [x] 更新延迟事件可展示：最新快照超 SLA（official_index 45 天/其余 10 天）→ watch 用户各一条 `update_delayed`，每用户每对象每日最多一条
- [x] **验收①：邮件 provider 不可用时站内事件依然保留**——故障注入（provider 抛错/未配置）后 alert_events 行不变、in_app 投递完好、email 行恒 `provider_error` 非 sent、事件接口与页面正常（vitest 三注入分支 + 本地/生产投递分布实测 email 全 provider_error）
- [x] **验收②：用户只能访问自己的事件**——两用户列表互不含；读取/标记他人事件 404；API 无 user_id 入参通道；公开接口零事件数据（vitest + 本地/生产 e2e id 不相交双证）
- [x] 03C 五场景自动化测试：目标价上方不触发、首次跌破生成、持续低于不重复、回升超缓冲 re-arm、再次跌破新事件
- [x] 幂等：同批次复跑/重复 evaluate 零新增事件（event_key UNIQUE）
- [x] 质量门控：stale 快照不触发，low_sample 可触发且证据标注质量
- [x] 规则版本留存：evidence_json 含触发时 version 与目标值，改目标价不影响历史事件

## 前端

- [x] /events 真实接线：登录态拉取、时间线渲染（字段来自 API 不造数）、全部/未读/已读筛选、标记已读/未读、证据展开、加载/空/错误态
- [x] 首页「今日与我有关」真实事件卡（今日 top3、未登录引导、空态）
- [x] AppShell 通知入口未读角标（unread_count>0 显示、已读后同步）
- [x] 未登录访问 /events 跳 `/login?next=/events`
- [x] 演示模式（PUBLIC_DEMO_DATA=1）零回归

## 工程门禁

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test`（181）/ `pnpm -r build` 全绿
- [x] `py -3 -m pytest collectors/tests`（100 passed）全绿（零 Python 改动回归）
- [x] 本地 wrangler dev e2e：五场景、系统事件构造、签名 evaluate 端点、故障注入、隔离 404 全部通过
- [x] 生产部署（wrangler deploy 含 cron 触发器）+ 生产 e2e 冒烟通过（26/26）
- [x] 中文 commit + push + CI 绿（807f375，run 43366957330 success）
- [x] 验收报告 `docs/TASK-05A-站内事件中心验收报告.md` 入库
- [x] 记忆更新（topics.md / project_memory.md）

## 偏差记录（实施期如实填写）

- 后端 `GET /me/events` 的 `unread` 参数仅支持 `true`（加 `read_at IS NULL` 过滤），`unread=false` 不过滤、全量返回；因此前端「已读」筛选在已拉取列表上按 `status` 本地分流——功能验收通过，服务端 `unread=false` 过滤归后续任务。
- `EventTimelineItem.astro` 的组件脚本位于 `<template>` 内不执行（既有结构）；真实分支复刻了其两条委托交互（证据展开/收起），演示分支渲染零变化。
- 浏览器验收环境：`PUBLIC_API_BASE` 须与页面同 host（localhost），否则 localhost cookie 不随跨 host fetch 发送；已在验收报告 §6 备注。
