# Checklist — TASK-05B 邮件提醒和每日摘要

## 验收清单（PRD 任务行 1328–1334）

- [x] **事件邮件内容**：达到目标后发送 price_alert 邮件，含对象、指标、目标与当前值、差值、数据日期、来源、样本量与链接（§7.2 九要素）；正文与任何持久化/日志零内部字段名暴露
- [x] **发送幂等**：同一事件不重复发送邮件（delivery 行兜底）；同一用户同一北京日摘要只发一封（ledger request_id 幂等键）；重复 evaluate / 重复触发 cron 零重复
- [x] **每日限额**：滚动 24h 共享 80 封总帽核验，通知侧可用 80−60；达限**不调用 provider**，email 行 `quota_deferred` + 账本 `quota_blocked`，站内事件保留，不自动切付费服务
- [x] **失败重试有限**：provider 失败立即重试 1 次（共 2 次尝试），仍失败 `provider_error`/attempt_count=2；错误消息与邮箱不入库；站内事件与 in_app 投递不受影响
- [x] **每日摘要**：全局 cron 北京 07:30（`30 23 * * *` UTC）；`digest_enabled=1` 且 email 开启才发送；聚合上一北京日事件（价格变化/事件/监控状态）；**无事件用户跳过不发**
- [x] **摘要字段**：明细含对象、类型、变化摘要、链接；同样零内部字段名
- [x] **OTP 不受影响**：auth 额度判定与 02C 测试零变化；通知发送不侵占 OTP 预留 60
- [x] **mail_gateway.gs**：price_alert/daily_digest 模板实现（验签/防重放/白名单结构不变），交付待部署

## 工程门禁

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿
- [x] `py -3 -m pytest collectors/tests` 全绿（零 Python 改动回归）
- [x] 本地 18789 e2e：测试桩邮件链路、幂等复跑、额度打满、重试计数（49/49）
- [x] 生产部署 + 冒烟（.gs 未部署 → provider_error 降级路径实证、站内保留）（13/13，deploy b85a7c70）
- [x] 浏览器抽查 events 页零回归（本期无前端改动）
- [ ] 中文 commit + push + CI 绿
- [x] 验收报告 `docs/TASK-05B-邮件提醒与每日摘要验收报告.md` 入库
- [ ] 记忆更新（topics.md / project_memory.md）

## 偏差记录（实施期如实填写）

- 样本量口径：邮件「样本量」= 快照聚合观测行数（单观测批次 1 条），非观测内 sample_count 字段；详见验收报告 §7.1
- 生产网络抖动造成重复规则/事件与幽灵批次，已定向清理（报告 §7.2）；.gs 未部署期间生产邮件持续 provider_error 降级（spec 预期）
