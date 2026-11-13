# TASKS — TASK-05C 浏览器通知（可选）

> 流程：SubTask 全勾后方可收尾 §12.0 报告；实施期如实填写偏差。

- [x] Task 0: 流程启动
  - [x] SubTask 0.1: 读任务行 1336–1342 与 §7.2/§9.2/§11.2/行 226/287；4 项拍板（完整实现+测试桩、0007 新表、404/410 即删+cron 60 天、全部事件与站内一致）
  - [x] SubTask 0.2: 打 tag `pre-v1-p2-task-05c`；写 spec.md / tasks.md / checklist.md 待批
- [x] Task 1: 订阅存储（DB 0007）
  - [x] SubTask 1.1: `db/migrations/private/0007_push_subscriptions.{up,down}.sql`（endpoint UNIQUE、status CHECK、ON DELETE CASCADE、last_seen_at）
  - [x] SubTask 1.2: `packages/migrations/src/index.test.ts` PRIVATE_TABLES 21→22 + 幂等/UNIQUE/CHECK/CASCADE 断言（25 passed）
- [x] Task 2: 发送链路 push.ts
  - [x] SubTask 2.1: VAPID ES256 JWT（WebCrypto 签名，aud/exp/sub）+ RFC 8291 aes128gcm 加密（ECDH+HKDF+AES-GCM）
  - [x] SubTask 2.2: sendPush——发送/重试 1 次/404·410 删订阅/投递行 channel='browser_push'（幂等、只落错误码）/last_seen_at 更新（重试计数在 dispatchPushChannel，与 05B sendEmail 接缝同构；见 checklist 偏差记录）
  - [x] SubTask 2.3: env.ts 增 VAPID_* 三配置；`GET /public/push-config` 公开端点（未配置 enabled:false）
  - [x] SubTask 2.4: dispatchNotification 第 6 步接入（独立 try/catch、渠道互不阻断、browser_push_enabled 缺行=0 不推、不查邮件帽）
  - [x] SubTask 2.5: vitest——JWT 验签、RFC 8291 可逆解密、dispatch 各分支（enabled/无订阅/404 清理/重试 2 次/渠道独立/payload 禁词/幂等）、cron 60 天清理（14 tests 全绿，全量 207 passed）
- [x] Task 3: 订阅 CRUD 与 schema
  - [x] SubTask 3.1: POST/GET/DELETE /me/push-subscriptions（upsert、聚合数、404 跨用户隔离；他人占用 endpoint → 409 不抢归属）
  - [x] SubTask 3.2: schemas.ts 订阅 body 校验（URL、base64url keys）；validation.ts 白名单已够用未扩关键字
  - [x] SubTask 3.3: scheduled digest 分支追加订阅清理（独立 waitUntil + catch，日志 cron-push-cleanup 记 removed；me.test 44 + index.test 11 全绿，全量 215 passed）
- [x] Task 4: 前端
  - [x] SubTask 4.1: account.astro 五态状态机（不支持/granted+订阅+enabled=1→已开启+关闭/granted 未订阅或 enabled=0→已授权+开启/denied→已拒绝/default→未授权）；开启=requestPermission(仅click)→push-config→subscribe→POST→PATCH enabled=true；关闭=unsubscribe→DELETE(404 容忍)→PATCH false；DEMO 不打真实 API；api.ts 增 6 个推送函数（astro check 0 错）
  - [x] SubTask 4.2: sw.js `push` showNotification(title,{body,icon,badge,tag,data:{url}}，解析失败走通用标题) + `notificationclick` 聚焦跳转/开窗 + VERSION 20261113.1（sw-test PWA 验收全通过、build 13 页成功）
- [x] Task 5: 门禁与验收
  - [x] SubTask 5.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` + `py -3 -m pytest collectors/tests` 全绿
  - [x] SubTask 5.2: 本地 18789 e2e——桩端点收到 vapid 头与密文、404 删订阅、cron 清 61 天休眠、CRUD 权限隔离（39/39 PASS；种子补公库来源三件套+ingest 台账清理、VAPID exp 断言改相对当前时间）
  - [x] SubTask 5.3: 生产部署（0007 remote 已应用=22 表、VAPID 两 Secret+SUBJECT var 已配）+ 生产冒烟 17/17（push-config 公钥一致、CRUD、404 死端点即删+subscription_expired 不重试、in_app sent 渠道独立）；浏览器验收 6/6（页面 fetch 登录、开启/关闭闭环、denied 降级、events 零回归；偏差：无头环境真实 subscribe 不可用，用 mock 订阅断言状态机）
- [x] Task 6: 报告与收尾
  - [x] SubTask 6.1: `docs/TASK-05C-浏览器通知验收报告.md`
  - [x] SubTask 6.2: 中文 commit（UTF-8 `-F`）→ push → 盯 CI 绿（c6173ba 已推送，CI run 43401246012 success）
  - [x] SubTask 6.3: checklist 勾选入库 → 记忆更新 → §12.0 收尾报告
