# TASK-05C 浏览器通知（Web Push）— 验收报告

> 对应 PRD V1.2 任务行 1336–1342；规格三件套 `.trae/specs/browser-push/`（已批准）。
> 验收日期：2026-11-13；tag 备份：`pre-v1-p2-task-05c`；生产部署版本：`96c92dc9-c7af-4f1b-a947-4b5cf0ed7cba`（deploy `30459b73` + VAPID 两 Secret）。

## 1. 拍板决定（4 项，均按 Recommended 落地）

| #   | 议题             | 拍板                                                                              |
| --- | ---------------- | --------------------------------------------------------------------------------- |
| 1   | 实现深度         | 完整实现 + 测试桩：真实 VAPID（ES256 JWT，WebCrypto 零依赖）+ RFC 8291 aes128gcm   |
| 2   | 存储             | Private 0007 新表 `push_subscriptions`（私库第 22 张表），endpoint/密钥只入私库   |
| 3   | 失效清理         | 网关 404/410 即删订阅；每日 cron（`30 23 * * *`）清 60 天未 `last_seen_at` 的订阅 |
| 4   | 事件与投递口径   | 全部事件与站内一致（`browser_push_enabled=1` 且有订阅才投）；不占邮件帽、无 quota_deferred |

## 2. 交付物

**API（apps/api/src）**

- `push.ts`（新）：`signVapidJwt`（ES256，payload `{aud:endpoint origin, exp:+12h, sub}`，私钥 PKCS#8 DER base64url 导入）+ `encryptWebPush`（RFC 8291 单记录：ECDH 临时密钥 → HKDF-IKM → RFC 8188 头 `salt(16)||rs(4,大端4096)||idlen(1)=65||keyid(65)`，CEK/NONCE 单记录 SEQ=0，末记录分隔 0x02，AAD 零长度）+ `sendPush`（`Authorization: vapid t=…, k=…`、`Content-Encoding: aes128gcm`、`TTL: 86400`、`Urgency: normal`；404/410→`subscription_expired` 不重试并删订阅、429/5xx/网络→`provider_unavailable` 可重试、其他 4xx→`provider_error`、2xx 刷 `last_seen_at`）；`PushError{code,retryable}`；模块零日志落 endpoint/密钥。
- `routes/me.ts`：订阅 CRUD 三端点——POST `/push-subscriptions`（schema→`new URL()` 语义校验→他人占用 409→同 endpoint upsert 幂等同 id）、GET（仅 `count/active_count` 聚合，不回显）、DELETE（跨用户/不存在 404→204）。
- `events.ts`：`dispatchNotification` 第 3 渠道独立 `try/catch`——in_app → email（05B）→ browser_push；`DispatchOptions.sendPush` 测试接缝；`dispatchPushChannel` 落行（成功 `sent`+`attempt_count`+`sent_at`；失败 `provider_error`+稳定 `last_error_code`），重试 2 次在渠道内计数。
- `index.ts`：digest cron 分支追加独立 `waitUntil(cleanupStalePushSubscriptions)`（日志 `request_id=cron-push-cleanup`，catch 只记稳定信息）。
- `schemas.ts`：`createPushSubscriptionSchema`/`deletePushSubscriptionSchema`（手写白名单，`BASE64URL_PATTERN` 拦 padding）。
- `routes/public.ts`：`GET /push-config`（enabled + `public_key`，本地/生产同一路径）。
- `env.ts` + `wrangler.jsonc`：`VAPID_SUBJECT` var（`mailto:admin@example.com`）；`VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY` 走 Secret。
- `db/migrations/private/0007_push_subscriptions.up.sql`：新表 + 索引（endpoint UNIQUE、user_id、last_seen_at）；`PRIVATE_TABLES` 22；`apps/api/package.json` db:up/db:apply 脚本追加 0007。

**Web（apps/web）**

- `src/lib/api.ts`：+6 函数（getPushConfig / getPushSubscriptionCounts / createPushSubscription / deletePushSubscription / getNotificationPreferences / patchNotificationPreferences）。
- `src/pages/account.astro`：推送块五态状态机（不支持/denied→已拒绝+注记+disabled/default→未授权/granted+订阅+enabled→已开启+关闭按钮/其余 granted→已授权+开启）；开启=`requestPermission`（仅 click 触发）→push-config→`subscribe({userVisibleOnly,applicationServerKey})`→POST 存 `localStorage`→PATCH `browser_push_enabled:true`；关闭=unsubscribe→DELETE（404 容忍）→清 storage→PATCH false；DEMO 环境不打真实 API；任一步失败 toast 标注「邮件与站内事件不受影响」。
- `public/sw.js`：`push` 事件解析 `{title,body,url,tag}`（解析失败走通用标题兜底）→`showNotification`（icon/badge/tag/data.url）+ `notificationclick` 聚焦跳转/开窗；`VERSION=20261113.1`。

## 3. 测试与工程门禁（2026-11-13 实跑）

| 门禁                               | 结果                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `pnpm typecheck`                   | ✅ 0 错误 0 警告（api + web 双配置）                                     |
| `pnpm lint`（含 Prettier）         | ✅ All matched files use Prettier code style                             |
| `pnpm test`                        | ✅ **215 passed**（05C 新增：push 15 + me 推送 CRUD 6 + index cron 清理 2）|
| `pnpm -r build`                    | ✅ 5 包（web 13 页 + api Done；sw-test PWA 验收全通过）                  |
| `py -3 -m pytest collectors/tests` | ✅ **100 passed**（零 Python 改动回归）                                  |

新增测试要点：VAPID JWT 结构/12h 过期/缺私钥分类、RFC 8291 字节级头（salt 16/rs 大端/idlen=65/keyid=65）、404/410 删订阅不重试、429/5xx 可重试、聚合优先级 transient>expired>provider_error、2xx 刷 last_seen、dispatch 渠道独立（email 失败不影响 push）、cron 只在 digest 分支清 60 天、CRUD 权限隔离/幂等 upsert/schema 拒绝、聚合不回显密钥。

## 4. 本地 18789 e2e — **39/39 PASS**

环境：wrangler dev `--test-scheduled` + 桩推送网关 `127.0.0.1:18799`（记录 vapid 头/编码/密文，mode ok/404/410/429/500）+ HMAC 签名直发；脚本 `%TEMP%\pr05c-e2e.mjs`。种子：用户 A（armed 规则×3 不同对象）+ 61 天休眠订阅挂用户 B + 公库来源三件套。

| 场景               | 结果                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| push-config        | ✅ 200 + 公钥 = 本地 VAPID 公钥                                                                                                            |
| 订阅 CRUD          | ✅ 未登录 401、upsert 201 同 id、聚合 GET 不回显 endpoint/p256dh、跨用户 DELETE 404 行仍在、他人占用 endpoint 409、非法 endpoint 400、不存在 404 |
| 触发推送           | ✅ 桩恰 1 次：`vapid t=…, k=…` 头、JWT `aud`=端点 origin/`sub`/`exp`≈now+12h、`Content-Encoding: aes128gcm`、**body[20]=65**（idlen 字节位）、密文零明文（无对象名/事件名）、`TTL: 86400` |
| 投递落行           | ✅ browser_push `sent` `attempt_count=1`、订阅 `last_seen_at` 刷新；email 失败（无邮件桩）不影响 push —— 渠道独立实证                        |
| 幂等               | ✅ 同 batch 复跑 202 duplicate、事件不增、桩调用不增                                                                                        |
| 404 即删           | ✅ mode=404 后新批次：桩第 2 次、订阅行删除、`last_error_code=subscription_expired` `attempt_count=1` `status=provider_error`（恰 1 次不重试）|
| cron 清 60 天      | ✅ digest cron 后 61 天休眠订阅删、1 天新鲜订阅留、桩调用不增                                                                               |
| 正常第二投         | ✅ 新鲜订阅第 3 次桩调用、`sent` 累计 2 条                                                                                                  |

## 5. 生产部署 + 冒烟 — **17/17 PASS**

- `d1 execute radar_private --remote` 应用 0007 → 私库 **22 张表**；`wrangler deploy` 版本 `30459b73` → `secret put VAPID_PRIVATE_KEY/VAPID_PUBLIC_KEY` → 最终 `96c92dc9`；`VAPID_SUBJECT` 进 wrangler.jsonc vars。
- 冒烟脚本 `%TEMP%\pr05c-prod.mjs`（05B 会话 `u_e2e05b_p_a` 复用）：
  - ✅ 生产 `/public/push-config` 200 且公钥与上传 Secret 逐字节一致；
  - ✅ 订阅死端点（`…/api/v1/__dead_endpoint`）POST 201、聚合不回显、PATCH `browser_push_enabled=true`；
  - ✅ 新对象（生产库第二社区）建监控+规则（target 41000）→ 签名直发批次 → 事件生成；
  - ✅ **生产 404 清理链路实证**：browser_push 行 `provider_error` + `subscription_expired` + `attempt_count=1`（真实 VAPID 签名 + RFC 8291 加密打到生产 Worker 404 → 即删）；`in_app` `sent` 渠道独立；事件保留；订阅行删除；聚合归零。
- 生产 digest cron 内的清理分支无法外部手动触发（无 `/__scheduled`），以「部署注册 + 本地 e2e cron 双证」覆盖；首次自动执行为北京时间 2026-11-14 07:30。

## 6. 浏览器验收 — **6/6 PASS**（本地 astro dev 页面内 fetch 绕 Turnstile，05B 先例）

环境：`PUBLIC_API_BASE=http://localhost:18789/api/v1`、Turnstile 测试键（always-pass）、邮件验证码走桩网关 `/gateway`。

| 断言                     | 结果                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 登录链路                 | ✅ 页面内 fetch request-code 200 → 桩网关取 OTP（`702628`）→ verify-code 200 → account 页渲染推送块（基线「已授权/开启」，无头 Chrome 权限 granted） |
| 开启闭环（不弹窗）       | ✅ mock subscribe 注入 → 点击「开启」→ toast「浏览器推送已开启」、徽章「已开启」、按钮「关闭」、`count+1`、`browser_push_enabled=true` |
| 关闭闭环                 | ✅ 点击「关闭」→ toast「浏览器推送已关闭」、徽章回「已授权」、按钮回「开启」、计数回落、`browser_push_enabled=false`                  |
| denied 降级              | ✅ 注入 `permission='denied'`（自检 V1/V2 通过）→ 点击 → toast「已拒绝：自动降级为邮件 + 站内事件」、徽章「已拒绝」、按钮 disabled、denied 注记展示 |
| /events 零回归           | ✅ 事件统计/筛选/条目卡片正常渲染，控制台无 error 级消息                                                         |
| 控制台                   | ✅ 全程仅 Vite debug 日志，无 error                                                                              |

## 7. 偏差与工程记录（如实填写）

1. **重试计数归属**：spec 拟由 `sendPush` 内重试，实际由 `dispatchPushChannel` 在 dispatch 层计数（与 05B `sendEmail` 接缝完全同构）；`sendPush` 语义=单次尝试。行为口径不变（可重试错误恰 2 次尝试）。
2. **他人占用 endpoint 返回 409**：spec §3.2 只写跨用户 DELETE 404；POST 遇他人已用 endpoint 按 `errors.conflict` 返 409「该订阅端点已被使用」，防止抢占归属——比 spec 更严，记录为增强。
3. **无头浏览器真实 `PushManager.subscribe` 不可用**（`Registration failed - push service not available`，无头 Chrome 无推送服务连接）：浏览器验收用 mock 订阅（有效 base64url keys）断言状态机闭环；真实 VAPID+加密+网络链路由本地 e2e（桩网关字节断言）与生产冒烟（打真实生产 Worker 404 清理）双证覆盖。真实浏览器+真实推送服务全链路留待用户本机验证。
4. **登录自动化补齐**：本地 `.dev.vars` 追加 `APPS_SCRIPT_WEB_APP_URL`（桩网关 `/gateway` 发码）、`TURNSTILE_SECRET_KEY`（Cloudflare always-pass 测试键）、`SESSION_SIGNING_SECRET`（缺此 503「登录服务未配置」）——全部仅本地、`.dev.vars` 不入库。
5. **本地 e2e 种子工程**（自查修正 4 处）：休眠订阅改挂用户 B（避免 A 的事件投递污染桩计数）；新增第 3 个监控对象（已触发规则同对象复跑不再产生事件）；公库补来源三件套（data_sources/license/coverage，否则批次 404 `source_not_found`）+ 清 ingest 台账；VAPID `exp` 断言改相对当前时间（payload 无 `iat`）。
6. **生产冒烟尾部网络抖动**（fake-IP TUN 代理）：核心断言全过后 d1 尾查中断，拆 `%TEMP%\pr05c-prod-tail.mjs` 带重试补验 2 项（订阅行删、聚合归零）均 PASS。
7. **wrangler 工具链**：`wrangler deployments list` 管道被 `Select-Object -First` 提前关流致 exit -1（取全量再过滤即正常）；`d1 execute --json` 的帮助文案包在 results 里需按 `Total queries executed` 哨兵分流（脚本 d1 helper 已处理）。
8. **PWA 版本**：`sw.js` VERSION `20261113.1`——若用户此前已注册旧 SW，需硬刷新/等版本差更新；`sw-test` 已验 update 流程。

## 8. 待办移交

- [ ] 用户在本机真实浏览器点「开启」验证全链路（真实 push service 订阅 → 生产/本地事件 → 系统通知弹出与点击跳转）
- [ ] 2026-11-14 北京 07:30 观察生产 cron `cron-push-cleanup` 首跑日志（removed 计数）
- [ ] 生产前端域名确定后配置 `WEB_BASE_URL`（推送与邮件内页链接目前 localhost 缺省）
- [ ] 生产 e2e 残留（`u_e2e05b_p_a` 的第二监控/规则/target 41000 事件、`batch_e2e05c_prod_001/002`）可按 §7.2 标记清理（可选）
