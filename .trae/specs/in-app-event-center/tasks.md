# Tasks

- [x] Task 0: 流程启动
  - [x] SubTask 0.1: 读任务行 1322–1326 与关联章节（§2.8/§4.6/§4.7/§6.6/§7.2–7.4/§8.8/§9.2/US-07·08）；4 项范围决策拍板（生成=并入 03C 核心、系统事件按 watch 对象、投递占位+故障注入、前端=事件中心+首页卡+角标）
  - [x] SubTask 0.2: 打 tag `pre-v1-p2-task-05a`；写 spec.md / tasks.md / checklist.md 并获批
- [x] Task 1: 规则引擎（并入 03C 核心）
  - [x] SubTask 1.1: `apps/api/src/rules-engine.ts`——目标价三类规则状态机（armed→触发→triggered 抑制→hysteresis re-arm）+ `price_drop_pct` 窗口跌幅 + 质量门控（valid/low_sample 可触发，stale/outlier/rejected 不触发）+ `below_comparable_median_pct` 跳过注释；口径常量集中导出
  - [x] SubTask 1.2: 幂等与版本——event_key = rule_id|object|metric|snapshot_id UNIQUE 冲突静默跳过；evidence_json 落 version/target/统计日期/来源/样本量/质量/窗口明细；old/new/target/difference_pct 落列
  - [x] SubTask 1.3: 接入触发点——`writeObservations` 返回 snapshots_upserted>0 后在 `POST /internal/ingest/batch` 与 `POST /admin/observations` 调 `evaluateRulesForObjects`
  - [x] SubTask 1.4: vitest 五场景（目标价上方/首次跌破/持续低于/回升 re-arm/再次跌破）+ 批次复跑幂等零新增 + low_sample 可触发/stale 不触发
- [x] Task 2: 系统事件与触发入口
  - [x] SubTask 2.1: `evaluateSystemEvents(env, now)`——update_delayed（DELAY_SLA_DAYS 45/10 天、零快照不产、watch_id+当日幂等）+ data_anomaly（近 24h ingest_jobs failed / source_health down，对象→城市→来源跨库解析）
  - [x] SubTask 2.2: `POST /internal/events/evaluate`（复用 verifySignedRequest，返回 delayed/anomaly/skipped 计数）
  - [x] SubTask 2.3: Worker `scheduled` 处理器 + wrangler.jsonc `crons: ["30 0 * * *"]`，与端点共用同一函数
  - [x] SubTask 2.4: vitest——延迟判定边界（SLA 内/外/零快照）、异常归属（覆盖城市才生成）、多 owner 各一条、每日重复 evaluate 幂等
- [x] Task 3: 投递占位与故障隔离
  - [x] SubTask 3.1: `dispatchNotification`——事件先写、分发 try/catch；in_app 行 sent；email 按通知偏好写行 `provider_error/provider_unavailable`（attempt_count=0，不谎称已发送）
  - [x] SubTask 3.2: 故障注入测试——provider 抛错时 alert_events/in_app 行保留、email 行恒非 sent、接口正常
- [x] Task 4: API 扩展与隐私隔离
  - [x] SubTask 4.1: `GET /me/events` 增 type 过滤（非法 400）+ unread_count + evidence/snapshot_id 等 §2.8 全字段返回
  - [x] SubTask 4.2: `PATCH /me/events/:id/read` 扩 `{read?: boolean}`（false=标记未读，缺省已读，幂等，additionalProperties:false）
  - [x] SubTask 4.3: 隔离测试——两用户列表互不含、单条读/标记他人 404、无 user_id 入参通道、公开接口零事件数据
- [x] Task 5: 前端真实接线
  - [x] SubTask 5.1: events.astro 真实分支——401 跳转、GET 渲染时间线（级别映射/字段来自 API 不造数）、真实筛选、标记已读/未读调 API、证据明细、加载/空/错误态；演示分支保留
  - [x] SubTask 5.2: 首页「今日与我有关」真实事件卡 top3（今日、未登录引导、空态）+ AppShell 通知入口 unread_count 角标（>0 显示、已读同步）
  - [x] SubTask 5.3: 浏览器验收——真实模式事件全流程（本地 4321+18789 零 mock 17 断言全过：401 跳登录/9 条四类标签/证据展开/角标 9→8 刷新保持/首页 3 简卡/零 pageerror）+ 演示模式零回归（PUBLIC_DEMO_DATA=1 构建 + mock 冒烟 50 断言）
- [x] Task 6: 四门禁与本地/生产验收
  - [x] SubTask 6.1: `pnpm typecheck` / `pnpm lint` / `pnpm test`（181 tests）/ `pnpm -r build` 全绿 + `py -3 -m pytest collectors/tests`（100 passed）全绿（零 Python 改动回归）
  - [x] SubTask 6.2: 本地 wrangler dev 18789 e2e——规则五场景直发、系统事件（构造 failed job/老快照）、evaluate 端点签名调用、故障注入事件保留、隔离 404
  - [x] SubTask 6.3: 生产部署 e2e——`wrangler deploy`（含 cron）、签名调用 evaluate、事件/投递行冒烟、双用户隔离冒烟、邮件 provider_error 保留断言
- [x] Task 7: 验收报告与收尾
  - [x] SubTask 7.1: `docs/TASK-05A-站内事件中心验收报告.md`——五场景结果表、系统事件证据、故障注入对照、隔离验收、SLA/口径常量说明
  - [x] SubTask 7.2: 中文 commit `TASK-05A: …`（UTF-8 `git commit -F`）→ push → 盯 CI 绿（807f375 / run 43366957330 success）
  - [x] SubTask 7.3: §12.0 收尾报告 → checklist 勾选入库 → 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 0] 获批后方可开工
- [Task 1] 独立先行（Task 3 的 createEvent 调用点依赖事件写入函数）
- [Task 2] depends on [Task 1]（共用 createEvent/dispatch 通道）
- [Task 3] depends on [Task 1]
- [Task 4] depends on [Task 1, 2, 3]（返回字段含 evidence）
- [Task 5] depends on [Task 4]
- [Task 6] depends on [Task 1–5]
- [Task 7] depends on [Task 6]
