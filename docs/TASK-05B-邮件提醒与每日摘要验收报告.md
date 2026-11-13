# TASK-05B 邮件提醒和每日摘要 — 验收报告

> 对应 PRD V1.2 任务行 1328–1334 与 §6.6/§7.2–7.4/§8.8/§11.2–11.3；规格三件套 `.trae/specs/email-alert-digest/`（已批准）。
> 验收日期：2026-11-13；tag 备份：`pre-v1-p2-task-05b`；生产部署版本：`b85a7c70-ad51-4030-b1ec-d7906f6a4064`。

## 1. 拍板决定（4 项，均按 Recommended 落地）

| #   | 议题                 | 拍板                                                                        |
| --- | -------------------- | --------------------------------------------------------------------------- |
| 1   | mail_gateway.gs 模板 | 完整实现 price_alert/daily_digest + 本地测试桩；真实 .gs 交付待用户重新部署 |
| 2   | 摘要调度             | 全局 cron 北京 07:30（`30 23 * * *` UTC）；`digest_time` 存而不生效         |
| 3   | 额度口径             | 事件/摘要与 OTP 共享 80/24h 总帽，通知侧上限 = 80 − 60 = 20                 |
| 4   | 失败重试             | 立即重试 1 次，共 2 次尝试后收口                                            |

## 2. 交付物

**API（apps/api/src）**

- `email/quota.ts`（新）：`emailQuotaUsed`（24h 滚动 sent 合计 / otp / notify 三口径）+ `notificationQuotaExceeded`（totalCap=80、notifyCap=max(0, 80−60)）；`routes/auth.ts` 改用共享查询，行为零变化。
- `email/provider.ts`：新增 `EventMailContent`（对象/指标/目标/当前/价差/数据日期/来源/样本量/链接九要素）与 `EventMail`/`DigestMail`，接口加 `sendEvent/sendDigest`。
- `email/apps-script.ts`：抽 `postTemplate`（HMAC `${method}\n${body}\n${ts}\n${requestId}` + X-PR-* 头、错误分类与 sendOtp 逐字节一致），`sendEvent`→`price_alert`、`sendDigest`→`daily_digest`。
- `email/content.ts`（新）：`buildEventMailContent`（九要素全中文展示文案，gap 分「较目标/较窗口基线/较前值」三支）+ `buildDigestMailContent`（4 行概述 + 明细行 + 链接，主题含目标日与新事件数）；`EVENT_TYPE_LABELS` 镜像前端 events.ts。
- `events.ts`：`dispatchNotification` 真实发送链——in_app 落行 → 偏好检查 → **R1.4 幂等**（同 event 同 channel 只发一次，quota_deferred 可复用行重判）→ 额度核验（达限**不调 provider**，投递行 `quota_deferred` + 账本 `quota_blocked`）→ 发送重试循环（2 次尝试收口，成功记 `sent`、失败 `provider_error` + 稳定错误码）。辅助：`recordLedger`、`deliveryErrorCode`（gateway_not_configured→provider_unavailable 沿用 05A 语义）、`resolveSourceName`（绝不透 source_id）、`sendEventByEmail`（含 event_missing/recipient_unavailable 分类）。
- `digest.ts`（新）：候选=偏好双开用户；幂等键 `digest:{user_id}:{北京发件日}` 落 ledger.request_id、查重只认 `status='sent'`；聚合上一北京日事件（`date(created_at,'+8 hours')`），**无事件跳过不发**；达限只计数不记账；失败重试 2 次。
- `index.ts`/`wrangler.jsonc`：crons `["30 0 * * *","30 23 * * *"]`（北京 08:30 事件评估 + 07:30 摘要），scheduled 按 cron 分支、独立 try/catch。
- `rules-engine.ts`：evidence 增 `metric_label`（避免 events→content 循环依赖）；`env.ts` 增可选 `WEB_BASE_URL`（缺省 `http://localhost:4321`）。

**Apps Script（apps-script/mail_gateway.gs）**

- `doPost` 分派加 `price_alert`/`daily_digest` 分支（验签/防重放/白名单结构不变，未知模板仍拒绝）；新增 `buildPriceAlertHtml_`（对象/指标/目标(阈值)/当前值/价差/数据日期/来源/样本量 8 行表 + 事件中心链接）与 `buildDigestHtml_`（概述 + 对象|类型|变化|链接 明细表）；全部插值经 `htmlEscape_` 转义，主题 200 字截断。node 冒烟 `GS_TEMPLATE_SMOKE_OK`。**交付待部署**。

## 3. 测试与工程门禁（2026-11-13 14:26 实跑）

| 门禁                               | 结果                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                   | ✅ 0 错误 0 警告                                                                             |
| `pnpm lint`（含 Prettier）         | ✅ All matched files use Prettier code style                                                 |
| `pnpm test`                        | ✅ 11 文件 **193 passed**（05B 新增：events-mail 6 + digest 6 + rules-engine 限额/重试改造） |
| `pnpm -r build`                    | ✅ 5 包（web 13 页 + api Done）                                                              |
| `py -3 -m pytest collectors/tests` | ✅ **100 passed**（零 Python 改动回归）                                                      |

新增测试要点：九要素齐全 + 13 个内部字段名/表名/原始来源 ID 禁词零暴露、HMAC 可重算、幂等复跑网关仅 1 次、持续失败恰 2 次尝试（`attempt_count=2`、账本 0、邮箱不入库）、共享总帽（notify 上限打满即 `quota_deferred` 不调网关）、摘要聚合/无事件不发/同日复跑零新增/达限跳过、auth OTP 额度测试零变化。

## 4. 本地 18789 e2e — **49/49 PASS**

环境：wrangler dev `--test-scheduled`（cap 4/1 → notifyCap=3）+ 桩网关 `127.0.0.1:18799`（记录每次调用 method/headers/body，mode ok/fail/reject）+ 种子用户 `u_e2e05b_a`（4 监控 + armed 目标价规则 + 2 条昨日事件）。脚本 `%TEMP%\pr05b-e2e.mjs`。

| 场景                | 结果                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| batch1 触发事件邮件 | ✅ 202 受理，网关恰 1 次调用                                                                                                                                                                  |
| 九要素              | ✅ 对象=E2E-西园1（虚构）、指标=挂牌中位单价、目标=30000 元/㎡、当前=29500 元/㎡、价差含 -500、数据日期=2026-11-13、来源=E2E-开放来源（虚构）、样本量=1 条、链接=http://localhost:4321/events |
| 脱敏                | ✅ 13 个禁词（metric_code/difference_pct/target_value/stat_date/sample_count/evidence_json/alert_events/price_snapshots/src_e2e05b/unit_price/quality_status/watch_rules/user_id）零命中      |
| 网关 HMAC           | ✅ 以 `APPS_SCRIPT_HMAC_SECRET` 重算 `POST\n{body}\n{ts}\n{requestId}` 逐字节相等                                                                                                             |
| 幂等复跑            | ✅ 同 batch_id → 202 duplicate；新 batch 同观测 → 事件零新增；事件 cron（`30 0 * * *`）零新增，网关仍 1 次                                                                                    |
| 每日摘要            | ✅ cron（`30 23 * * *`）发送 1 封：主题含 `2026-11-12` 与 `2 条新事件`、概述 4 行、明细 2 行、链接正确；账本恰 1 条 sent 且 `request_id=digest:u_e2e05b_a:2026-11-13`                         |
| 摘要幂等            | ✅ 复跑 → `already_sent`，网关调用不增，账本仍 1 条                                                                                                                                           |
| 失败重试            | ✅ reject（quota_exhausted）→ 网关恰 2 次调用；email 行 `attempt_count=2`、错误码稳定串、账本 0 条 sent、站内事件保留                                                                         |
| 额度打满            | ✅ batch3 发送成功（notify=3 达上限）；batch4 → 网关调用数不变、`quota_deferred` `attempt_count=0` `last_error_code=quota_blocked`、账本 `quota_blocked` 1 条                                 |
| 总帽口径            | ✅ 账本 sent 合计 3 = 本地 4−1；email sent 恰 2 条、事件总数 6、in_app 4 条全保留                                                                                                             |

## 5. 生产部署 + 冒烟 — **13/13 PASS**

- `wrangler deploy`：版本 `b85a7c70-ad51-4030-b1ec-d7906f6a4064`，crons `30 0 * * *` + `30 23 * * *` 已注册。
- 远程种子 `u_e2e05b_p_a`（会话直插 D1，沿用 05A 造会话手法）→ 监控 `cmt_qd_02`（中海银海一号）+ 目标价 36000 规则 → 签名直发批次 34800：
  - ✅ 事件生成，`evidence.metric_label=挂牌中位单价`（05B 新增字段）在线上生效；
  - ✅ **降级路径实证**：生产 `APPS_SCRIPT_*` 密钥未配置 → `gateway_not_configured` → email 行 `provider_error`、`attempt_count=2`、`last_error_code=provider_unavailable`；
  - ✅ `in_app` 投递 `sent`、站内事件保留、近 1 小时账本无 sent 行（失败不入账）——与 spec 风险段预期完全一致。
- 生产摘要 cron 无法外部手动触发（无 `/__scheduled`），以「部署注册成功 + 本地 e2e 双证」覆盖；北京时间 2026-11-14 07:30 为生产首次自动执行。

## 6. 浏览器抽查（本期无前端改动，零回归）

- 本地 astro dev（`PUBLIC_API_BASE=http://localhost:18789/api/v1` + 测试 sitekey）：登录页 Turnstile 组件在自动化环境不稳定（重复执行告警、不发码），改为**页面内 fetch 直连真实 API** 完成 request-code → verify-code（HTTP 200 均由桩网关发码），登录后导航栏显示「事件通知，6 条未读」。
- `/events` 页渲染事件条目，**控制台无 error 级别消息**，无邮件/通知/摘要相关新增报错。
- 复核：DB/`/me/events` 均为 6 条（2 昨日 + 4 今日）——代理口述「7 条」为误读，以 API/DB 为准。

## 7. 偏差与工程记录（如实填写）

1. **样本量口径**：邮件「样本量」取快照 `sample_count`（=聚合观测行数）；单观测批次即为「1 条」，非观测内 `sample_count` 字段（35）。spec R1.2 字段语义不变，仅数据来源明确为快照聚合数。
2. **生产重复事件（已清理）**：生产网络（fake-IP TUN 代理）抖动导致监控/规则 POST「响应丢失但服务端已受理」，重试后生成重复规则 → 两条事件。已按 `event_id`/`rule_id` 定向清理（保留 1 规则 1 事件），并删除首次误用未收录对象的幽灵批次与快照。清理标记：私库 `u_e2e05b_p_a`、公库 `cmt_e2e05b_p1`、批次 `batch_e2e05b_prod_002`。
3. **wrangler 工具链坑**：`d1 execute --file` 远程模式只回统计不回 SELECT rows（须 `--command`）；PS5.1 `& npx` 会破坏 npx 可执行解析（直接 `npx` 正常）；node `execFileSync`+`shell:true` 不给含空格参数加引号（SQL 走临时文件或直调 wrangler.js bin）。
4. **登录自动化**：登录页 Turnstile UI 在浏览器代理下不可靠，e2e 改用页面上下文 fetch 走真实 API 链路（验证码仍经桩网关真实发送），不构成对生产登录的绕过。
5. `.gs` 模板未部署 → 生产 price_alert/daily_digest 在部署前持续 `provider_error` 降级（spec 已预见）；`WEB_BASE_URL` 生产未配置（暂无生产前端域名），邮件内页链接暂为 localhost 缺省，待生产前端 URL 确定后配置该变量。

## 8. 待办移交

- [ ] 用户重新部署 `apps-script/mail_gateway.gs`（部署后 price_alert/daily_digest 模板生效，届时可做真实邮箱回归）
- [ ] 生产前端域名确定后配置 `WEB_BASE_URL` secret/vars
- [ ] 2026-11-14 北京 07:30 观察生产摘要 cron 首跑日志（`request_id=cron-daily-digest` 的 candidates/sent/already_sent 计数）
- [ ] 生产 e2e 残留按 §7.2 标记清理（可选，不影响业务）
