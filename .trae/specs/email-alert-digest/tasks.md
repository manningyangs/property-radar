# TASKS — TASK-05B 邮件提醒和每日摘要

> 流程：SubTask 全勾后方可收尾 §12.0 报告；实施期如实填写偏差。

- [x] Task 0: 流程启动
  - [x] SubTask 0.1: 读任务行 1328–1334 与 §6.6/§7.2–7.4/§8.8/§9.2/§11.2–11.3；4 项拍板（完整实现+测试桩、全局 cron 简化 digest_time 不生效、共享 80 总帽、立即重试 1 次）
  - [x] SubTask 0.2: 打 tag `pre-v1-p2-task-05b`；写 spec.md / tasks.md / checklist.md 待批
- [x] Task 1: EmailProvider 扩展与事件邮件
  - [x] SubTask 1.1: `email/provider.ts` 增 `sendEvent/sendDigest` 结构化入参类型；`apps-script.ts` 实现网关调用（HMAC 同 sendOtp，模板名 price_alert/daily_digest）
  - [x] SubTask 1.2: `events.ts dispatchNotification` 接真实发送：额度核验 → sendEvent（含 1 次重试）→ email 行 sent/provider_error/quota_deferred + ledger 记账（sent/quota_blocked）
  - [x] SubTask 1.3: 事件邮件正文构造（§7.2 字段：对象/指标中文名/目标/当前/差值/数据日期/来源/样本量/链接，零内部字段名）
  - [x] SubTask 1.4: vitest——正文字段齐全与脱敏断言、幂等（delivery 行存在不重发）、邮件失败站内保留回归
- [x] Task 2: 每日摘要
  - [x] SubTask 2.1: `digest.ts`——digest_enabled 且 email 开启的用户聚合上一北京日事件（类型分布/级别/未读/监控数），无事件跳过；幂等键 `digest:{user_id}:{日期}` ledger.request_id 查重
  - [x] SubTask 2.2: 摘要正文（昨日价格变化/事件/监控状态概述 + 明细 + 链接，零内部字段名）
  - [x] SubTask 2.3: crons 追加 `30 23 * * *`（北京 07:30）+ scheduled 接入（独立 try/catch 不阻塞事件评估）
  - [x] SubTask 2.4: vitest——聚合正确、无事件不发、同日复跑零新增、quota 达限跳过计数
- [x] Task 3: 限额与重试收口
  - [x] SubTask 3.1: 共享总帽核验函数（80/24h sent 合计；通知侧 80−60 上限）达限不调 provider
  - [x] SubTask 3.2: 抛错桩 2 次尝试后 attempt_count=2 provider_error、错误消息与邮箱不入库
  - [x] SubTask 3.3: 全链路回归——auth OTP 额度测试零变化
- [x] Task 4: mail_gateway.gs 模板
  - [x] SubTask 4.1: 实现 price_alert/daily_digest HTML 模板（字段映射 R1.2/R2.3、未知模板拒绝、白名单结构不变），交付文件待用户部署
- [x] Task 5: 门禁与验收
  - [x] SubTask 5.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` + `py -3 -m pytest collectors/tests` 全绿
  - [x] SubTask 5.2: 本地 18789 e2e——mock 网关（测试桩路径）触发事件邮件/摘要、幂等复跑、额度打满 quota_deferred、重试 2 次
  - [x] SubTask 5.3: 生产部署 + 冒烟（evaluate/dispatch 正常、.gs 未部署时 provider_error 不影响站内）；演示模式/浏览器零回归（无前端改动，抽查 events 页）
- [x] Task 6: 报告与收尾
  - [x] SubTask 6.1: `docs/TASK-05B-邮件提醒与每日摘要验收报告.md`
  - [x] SubTask 6.2: 中文 commit（UTF-8 `-F`）→ push → 盯 CI 绿（0fd1f81，run 43379177213 success）
  - [x] SubTask 6.3: checklist 勾选入库 → 记忆更新 → §12.0 收尾报告
