# Checklist — TASK-05C 浏览器通知（可选）

## 验收清单（PRD 任务行 1336–1342）

- [x] **主动授权**：`Notification.requestPermission()` 仅由 account 页「开启」按钮触发，页面加载/游客路径零权限弹窗（浏览器验收全程仅点击触发，加载零弹窗）
- [x] **拒绝不影响其他功能**：denied 分支仅降级文案；邮件、站内事件、其他渠道零变化（行 226/1342；浏览器 denied 降级 4 断言 PASS + dispatch 单测）
- [x] **可随时关闭**：关闭=unsubscribe → DELETE 订阅 → `browser_push_enabled=0`，关闭后 dispatch 不再推送（浏览器关闭闭环：计数回落+pref=false；单测 enabled=0 不投）
- [x] **订阅安全存储**：Private 0007 `push_subscriptions`；GET 仅回聚合数；endpoint/密钥不入公库、不入日志、不出现在他人可见响应（e2e 断言响应零回显）
- [x] **过期订阅清理**：发送收到 404/410 立即删除订阅；每日 cron 清理 60 天未 last_seen 休眠订阅（生产 404 死端点实证 + e2e mode=404 + cron 清 61 天）
- [x] **推送范围**：全部事件与站内一致；`browser_push_enabled` 缺行=0 不推；不占 80/24h 邮件总帽、无 quota_deferred（单测：偏好/缺行短路、渠道独立、无帽核验）
- [x] **VAPID+RFC8291 真实实现**：ES256 JWT 验签通过、密文可逆解密、桩端点收到 `Authorization: vapid` 与 `Content-Encoding: aes128gcm` 且密文无明文业务字段（e2e：JWT aud/sub/exp 断言 + body[20]=65 + 密文零明文）
- [x] **投递行语义**：channel='browser_push'、幂等不重复推、失败只落错误码（subscription_expired/provider_unavailable/provider_error）、2 次尝试（单测 + e2e/生产冒烟）
- [x] **SW 通知展示**：`push` 事件 showNotification（服务端下发内容）+ `notificationclick` 开窗/聚焦（sw-test PWA 验收全通过）
- [x] **按支持情况显示**：无 PushManager/非安全上下文显示「环境不支持」，不禁用其他渠道（五态状态机 + astro check 0 错）

## 工程门禁

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿（215 passed / build 13 页）
- [x] `py -3 -m pytest collectors/tests` 全绿（100 passed，零 Python 改动回归）
- [x] 迁移测试：PRIVATE_TABLES=22，0007 up 重复幂等、down 干净、UNIQUE/CHECK/CASCADE 生效
- [x] 本地 18789 e2e：桩端点 vapid+密文、404 删订阅、cron 清 61 天休眠、CRUD 隔离（39/39 PASS）
- [x] 生产部署 + db:apply 0007 + 冒烟（push-config、订阅 CRUD、404 死端点清理链路）（17/17 PASS，私库 22 表）
- [x] 浏览器验收：不弹窗断言、开启/关闭流、denied 降级、events 页零回归（6/6 PASS）
- [x] 中文 commit + push + CI 绿（主体 c6173ba 已推送，CI run 43401246012 success）
- [x] 验收报告 `docs/TASK-05C-浏览器通知验收报告.md` 入库
- [x] 记忆更新（topics.md 05C 完成条目 / project_memory.md 05C 教训 5 条）

## 偏差记录（实施期如实填写）

1. **重试计数归属**：spec 拟 `sendPush` 内重试，实际由 `dispatchPushChannel` 在 dispatch 层计数（与 05B `sendEmail` 接缝同构），`sendPush`=单次尝试；行为口径不变（可重试恰 2 次尝试）。
2. **他人占用 endpoint → 409**：spec §3.2 只写跨用户 DELETE 404；POST 遇他人已用 endpoint 返 409 防抢占归属（增强，更严）。
3. **无头浏览器真实 `PushManager.subscribe` 不可用**（push service not available）：浏览器验收以 mock 订阅（有效 base64url keys）断言状态机闭环；真实链路由本地 e2e（桩网关字节断言）+ 生产冒烟（打真实生产 Worker 404 清理）双证。真实浏览器全链路移交用户本机验证。
4. **本地登录链路补齐**（仅本地 `.dev.vars`，不入库）：`APPS_SCRIPT_WEB_APP_URL`（桩网关 `/gateway` 发码）、`TURNSTILE_SECRET_KEY`（Cloudflare always-pass 测试键）、`SESSION_SIGNING_SECRET`（缺则 503 登录服务未配置）。
5. **e2e 种子自查修正 4 处**：休眠订阅挂用户 B（防污染桩计数）、加第 3 监控对象（已触发规则复跑不再出事件）、公库来源三件套 + ingest 台账清空（否则批次 source_not_found）、VAPID exp 断言改相对当前时间（payload 无 iat）。
6. **生产冒烟尾部网络抖动**：核心断言 PASS 后 d1 尾查中断，拆 `pr05c-prod-tail.mjs` 重试补验 2 项均 PASS。
