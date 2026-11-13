# SPEC — TASK-05C 浏览器通知（可选）

> PRD 任务行 1336–1342：用户允许后接收浏览器通知。要求：用户主动授权、可随时关闭、Push Subscription 安全存储、过期订阅清理。验收：拒绝权限不影响其他功能；不在用户未授权时请求通知。
> 关联规范：§7.2（浏览器通知=主动授权后的增强功能，需 SW/Push Subscription，按浏览器支持情况显示）、§9.2（notification_preferences.browser_push_enabled、notification_deliveries.channel 含 browser_push）、§11.2（用户主动授权后发送；拒绝不影响站内事件）、行 226（拒绝浏览器通知不影响站内事件和邮件设置）、行 287（通知偏好含浏览器推送可选）。

## 0. 四项拍板（用户已裁决）

1. **推送链路 = 完整实现 + 测试桩**：Workers 上真实实现 VAPID（ES256 JWT，WebCrypto）+ RFC 8291 aes128gcm 载荷加密 + 订阅 CRUD + 事件触发发送；本地 e2e 用桩端点（订阅 endpoint 指向本地 mock 网关）验证请求头与密文载荷；真实浏览器订阅受环境限制的偏差如实记录。
2. **订阅存储 = Private 库新表 0007 `push_subscriptions`**（不 ALTER 旧表，up/down 幂等，`PRIVATE_TABLES` 21→22）。
3. **过期清理 = 发送时 404/410 立即删除 + 每日 cron 清理超过 60 天 `last_seen_at` 的休眠订阅**。
4. **推送范围 = 全部事件，与站内一致**（凡进入 `dispatchNotification` 的事件都推；前提是 `browser_push_enabled=1` 且存在有效订阅）。

## 1. 边界与红线

- **不在用户未授权时请求通知**：`Notification.requestPermission()` 只在 account 页「开启」按钮的 click 处理器内调用；任何页面加载/游客路径不弹权限框（行 1342）。
- **拒绝权限不影响其他功能**：permission=denied 时仅展示降级说明（既有文案），邮件/站内事件/其他渠道零改动（行 226/1342）。
- **可随时关闭**：前端 `pushManager.unsubscribe()` → DELETE 订阅 → `browser_push_enabled` 置 0；关闭后 dispatch 不再推送。
- **订阅安全存储**：endpoint 与 p256dh/auth 密钥只入 Private D1（§9.4 私库不直连客户端）；不入 Public 库、不入日志（访问日志只记路径）、不出现在任何响应中他人可见字段（GET 仅返回自己的条数与状态）。
- **推送不占邮件总帽**：80/24h 是邮件帽（R3.2），browser_push 投递不计入、不触发 quota_deferred（本次拍板 4 附带前提）。
- **payload 脱敏**：推送正文复用邮件同源构建规则——中文事件名 + 对象展示名 + 差值/目标 + `WEB_BASE_URL` 链接；零内部字段名、零 source_id、不落邮箱（13 禁词口径同 05B）。
- **不新增付费依赖**：Web Push 走浏览器 Push Service（FCM/AutoPush）免费；不引入付费服务、不改 Cloudflare 计划（§12.0-9）。
- **按浏览器支持情况显示**：无 `PushManager`/非安全上下文（iOS Safari 需 PWA 添加到主屏）时显示「环境不支持」，不禁用其他渠道（§7.2）。

## 2. 数据库（Private 0007）

```sql
CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,   -- Push Service 端点（含机密路径段，唯一）
  p256dh          TEXT NOT NULL,          -- base64url 订阅公钥（RFC 8291 加密用）
  auth            TEXT NOT NULL,          -- base64url 认证密钥
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'stale')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_push_subs_user_status ON push_subscriptions (user_id, status);
```

- 幂等（IF NOT EXISTS）；down 逆序 DROP（先于 0001 users 删除则无需级联顾虑，down 文件只 drop 本表）。
- `packages/migrations/src/index.test.ts` `PRIVATE_TABLES` +1（22 张）；断言 up 重复幂等、down 干净、endpoint UNIQUE、status CHECK 生效、ON DELETE CASCADE。

## 3. API

### 3.1 公开端点（订阅所需公钥）

- `GET /public/push-config` → `{ enabled: true, public_key }`；`VAPID_PUBLIC_KEY` 未配置时 `{ enabled: false }`。公钥非机密（applicationServerKey 本就分发给浏览器），注册在 `/communities/:id` 之前的 public 路由段，无需鉴权、无个人信息。

### 3.2 私有端点（me.ts，requireSession）

- `POST /me/push-subscriptions`：body `{ endpoint, keys: { p256dh, auth } }` → upsert（endpoint UNIQUE 冲突则更新 keys/status='active'/`last_seen_at=now`）→ 201 `{ subscription_id }`。校验 endpoint 为 http(s) URL、keys 为非空 base64url。
- `GET /me/push-subscriptions` → `{ count, active_count }`（仅自己的聚合数，不回 endpoint/密钥）。
- `DELETE /me/push-subscriptions`：body `{ subscription_id }` → 204；不存在/非本人 → 404。
- `PATCH /me/notification-preferences` 已支持 `browser_push_enabled`（05A 已有），零改动。

### 3.3 无 VAPID 密钥时

POST 订阅仍可存（存储与密钥无关），但发送侧 `VAPID_PRIVATE_KEY` 缺失 → 走 `provider_unavailable` 语义降级（同 05A/05B 网关未配置链路：不谎称已发送、不影响站内与邮件）。本地与生产均按 05B 模式在 `.dev.vars` / wrangler secret 配置。

## 4. 发送链路（apps/api/src/push.ts 新模块）

1. **VAPID JWT**：ES256 签 `{aud: endpoint 的 origin, exp: now+12h, sub: VAPID_SUBJECT}`，`Authorization: vapid t=<jwt>, k=<public_key>`（WebCrypto ECDSA P-256；`VAPID_SUBJECT` 缺省 `mailto:admin@example.com` 非敏感 var）。
2. **RFC 8291 加密**：ECDH(P-256) × auth → HKDF-SHA256（salt=auth, ikm=ecdh, info="WebPush: info\0"+ua_public+ua_public）得 IKM → 两次 HKDF 得 CEK/nonce → AES-128-GCM 加密 JSON payload → body = `salt(16) || rs(4)=4096 || idlen(1)=65 || keyid(65) || ct`；头 `Content-Encoding: aes128gcm`、`Content-Type: application/octet-stream`、`TTL: 86400`、`Urgency: normal`。
3. **响应处理**：2xx=成功；**404/410=订阅失效 → 立即 DELETE 该订阅**并落投递行（见下）；429/5xx=瞬时失败 → 立即重试 1 次（共 2 次尝试，与邮件 R3.3 一致）；其他 4xx=配置错误 `provider_error`。
4. **投递行**：`notification_deliveries.channel='browser_push'`、`provider='web_push'`。幂等与邮件同构：同事件已有非 quota 行则不重发；成功 `sent`+attempt_count+sent_at；失败 `provider_error`+last_error_code（`subscription_expired`/`provider_unavailable`/`provider_error`），只落错误码不落 endpoint（隐私最小化）。
5. **偏好核验**：`browser_push_enabled` 缺行=默认 0（0001 DEFAULT 0，未主动开启不推）→ 关闭或无订阅直接跳过；**不查邮件偏好、不查规则级 notify_email**（规则表无 push 列，推送仅用户级开关）。发送成功后更新 `last_seen_at`。
6. **注入接缝**：`DispatchOptions.sendPush?: (event) => Promise<void>`，与 `sendEmail` 同构，测试注入成功桩/抛错桩/404 桩。

### dispatchNotification 接入

站内（1）与邮件（2–5）逻辑之后追加独立 `try/catch` 的第 6 步 push：任何推送故障绝不影响 in_app/email 已完成的投递；反之邮件 quota/关闭也不阻断推送（渠道独立）。

### cron 清理

`index.ts` scheduled 的 digest cron 分支追加独立 `waitUntil + catch`：`DELETE FROM push_subscriptions WHERE status='active' AND last_seen_at < datetime('now','-60 days')`（也可置 status='stale' 后再删，实现取直接删），日志 `cron-push-cleanup` 记 `removed` 数。

## 5. 前端

### 5.1 account.astro「浏览器推送」行（改造现有块）

状态机（读不弹窗）：
- 不支持（无 `PushManager`/无 Notification/非安全上下文）→ 「环境不支持」+禁用按钮（文案已存在）。
- `permission=granted` + 已有本地订阅（`reg.pushManager.getSubscription()`）+ `browser_push_enabled=1` → 「已开启」+「关闭」按钮。
- `permission=granted` 但未订阅/enabled=0 → 「已授权」+「开启」。
- `permission=denied` → 「已拒绝」+降级说明（保留现有文案）。
- `permission=default` → 「未授权」+「开启」。

「开启」click 流程：`requestPermission()`（仅此触发弹窗）→ granted → 拉 `GET /public/push-config`（enabled=false 或无公钥 → toast「推送服务未配置」）→ `reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` → `POST /me/push-subscriptions` → `PATCH notification-preferences {browser_push_enabled: true}` → toast 成功。任一步失败不改变既有渠道（catch + toast）。

「关闭」click 流程：`pushManager.unsubscribe()` → `DELETE /me/push-subscriptions` → `PATCH {browser_push_enabled: false}` → toast。API 未登录（401）时按 api.ts 既有跳转。

演示模式（DEMO）：沿用现有分支策略——按钮仅做本地权限演示 + toast 标注「演示环境不会真实订阅」，不打真实 API。

### 5.2 sw.js

- `push` 监听：`event.waitUntil(registration.showNotification(title, { body, icon: /icons/icon-192.png, badge, tag: event_key, data: { url } }))`；payload 解析失败时显示通用标题（不白屏）。标题/正文由服务端下发，SW 不自行拼业务数据。
- `notificationclick`：`event.waitUntil(clients.openWindow(url) 或 matchFocus 聚焦)`。
- `VERSION` 升号（20261113.1），保证 SW 更新提示链路被触发。

## 6. 测试计划

### vitest（apps/api）

- `push.test.ts`：
  - VAPID JWT：header alg ES256、payload aud/exp/sub、用公钥 WebCrypto 验签通过。
  - RFC 8291：用测试密钥对加密后可被对应私钥解密还原（测试内实现逆向解密），salt/rs/idlen/keyid 结构正确。
  - dispatch 集成（mock D1 模式沿用 events-mail.test）：enabled=1+订阅 → channel 行 sent；enabled=0/缺行 → 零 push 调用；无订阅 → 零调用；404 → 订阅被删 + 行 provider_error/subscription_expired；429 两次尝试 attempt_count=2；邮件 quota 达限时 push 仍发送（渠道独立）；payload 无禁词/无 source_id；重复事件不重复推（delivery 幂等）。
  - cron 清理：61 天前 last_seen 删除、新鲜订阅保留。
- `packages/migrations/index.test.ts`：PRIVATE_TABLES=22、0007 幂等/UNIQUE/CHECK/CASCADE。

### 本地 e2e（18789 + 桩网关 18799）

- 种子订阅 endpoint=`http://localhost:18799/push` → 触发事件 → 桩收到带 `Authorization: vapid …` 与 `Content-Encoding: aes128gcm` 的 POST，密文非明文（不出现对象名）。
- 桩 mode=404 → 订阅行被删、投递行 subscription_expired。
- `/__scheduled` digest cron → 61 天前订阅被清理。
- `GET /public/push-config` 有公钥；订阅 CRUD 权限（他人 404）。

### 生产冒烟

- deploy 后 `db:apply 0007`；`/public/push-config` 返回公钥；种子会话（05B 同法直插 token_hash）POST/GET/DELETE 订阅；endpoint 指向本 API 一条必然 404 的路径（如 `/api/v1/__dead_endpoint`）→ 触发投递 → 断言订阅被删 + 投递行 subscription_expired（验证 404 清理链路真实生效）。
- 真实浏览器推送若环境可达 FCM 则实测 showNotification，否则如实记录偏差（同 05B 模式）。

### 浏览器验收

登录真实链路（页面内 fetch 绕 Turnstile 自动化，05B 先例）→ account 页：default 态按钮不弹窗、点开启弹权限、granted 后订阅建立（或环境不支持时的降级文案）、关闭流程回落、denied 分支文案、拒绝后 events/邮件设置零变化、控制台无 error。

## 7. 交付文件清单

| 文件 | 改动 |
|---|---|
| `db/migrations/private/0007_push_subscriptions.{up,down}.sql` | 新增 |
| `packages/migrations/src/index.test.ts` | PRIVATE_TABLES +1 |
| `apps/api/src/env.ts` | `VAPID_PRIVATE_KEY`/`VAPID_PUBLIC_KEY`（Secret）、`VAPID_SUBJECT`（var） |
| `apps/api/src/push.ts`（新） | VAPID JWT、RFC 8291 加密、sendPush、404/410 清理 |
| `apps/api/src/events.ts` | dispatchNotification 第 6 步 + `sendPush` 接缝 |
| `apps/api/src/index.ts` | digest cron 分支追加订阅清理 |
| `apps/api/src/routes/public.ts` | `GET /public/push-config` |
| `apps/api/src/routes/me.ts` | 订阅 CRUD 三端点 |
| `apps/api/src/schemas.ts` + `validation.ts`（如需扩关键字） | 订阅 body 校验 |
| `apps/api/src/push.test.ts`（新） | §6 单测 |
| `apps/web/src/pages/account.astro` | 推送状态机 + 开启/关闭流 |
| `apps/web/public/sw.js` | push/notificationclick + VERSION 升号 |
| `.dev.vars`（不入库）/ wrangler secret | VAPID 密钥对生成与配置 |

## 8. 验收对照（PRD 行 1342）

| 验收 | 落点 |
|---|---|
| 拒绝权限不影响其他功能 | 拒绝分支仅文案；dispatch 各渠道独立 try/catch；回归 events/邮件测试全绿 |
| 不在未授权时请求通知 | requestPermission 仅在 click 处理器；浏览器验收断言页面加载零权限弹窗 |
| 主动授权、可随时关闭 | 开启/关闭双流程 + 订阅 DELETE + browser_push_enabled 联动 |
| 订阅安全存储 | Private 0007 新表；GET 只回聚合数；不入日志/公库 |
| 过期订阅清理 | 404/410 即删 + cron 60 天休眠清理（e2e 各验证一次） |
