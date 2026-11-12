# Tasks

- [x] Task 1: 数据库迁移 0003 —— 分组存储
  - [x] SubTask 1.1: 新增 `db/migrations/private/0003_watch_item_groups.up.sql` / `down.sql`（幂等 CREATE INDEX/TABLE IF NOT EXISTS、DROP IF EXISTS，SQL 见 spec 第 4 节）
  - [x] SubTask 1.2: `packages/migrations/src/index.ts` 的 `PRIVATE_TABLES` 清单加入 `watch_item_groups`（14→15），并同步迁移测试断言
- [x] Task 2: API 扩展（apps/api/src/schemas.ts + routes/me.ts）
  - [x] SubTask 2.1: `schemas.ts` —— `patchWatchItemSchema.status` 扩展 `paused`；新增可选 `group_name`（1–50 字符，POST 与 PATCH 共用；PATCH 需允许 `null`）
  - [x] SubTask 2.2: GET `/me/watch-items` 查询参数 `status|object_type|group_name|sort|order`（非法→400 `errors.validation`），响应 item 扩展 `group_name`（LEFT JOIN 分组表）
  - [x] SubTask 2.3: POST —— region/community 目录存在性校验（Public DB regions/communities，不存在→404），listing 不校验；可选分组入组；去重 409 保持
  - [x] SubTask 2.4: PATCH —— `group_name` 字符串 upsert / `null` 移出分组；status 暂停/恢复
  - [x] SubTask 2.5: `auto_monitoring` 批量计算（每类型 1 条 SQL，≤3 条，禁止 N+1；region/community 查 `price_snapshots`，listing 查 `listing_price_events_public`），GET/POST 响应均携带
  - [x] SubTask 2.6: 所有新查询强制 `user_id` 过滤，跨用户 404 保持
- [x] Task 3: API 与迁移测试
  - [x] SubTask 3.1: 扩展 me 相关测试：暂停/恢复往返与 status 筛选、sort/order 生效与非法参数 400
  - [x] SubTask 3.2: 分组测试：创建带组、PATCH 改组、`group_name=null` 移出、筛选生效、改名后旧组不命中
  - [x] SubTask 3.3: 去重 409、目录校验 404、`auto_monitoring` true/false 两态（测试内种子 TEST- 价格数据）、删除后 watch_rules + watch_item_groups 级联消失
  - [x] SubTask 3.4: 数据隔离（跨用户 GET/PATCH/DELETE → 404、group 筛选不泄漏）+ 多对象混合增删改查排序筛选交叉用例
  - [x] SubTask 3.5: 迁移测试：15 张表、up 重复执行幂等、down 干净；既有测试全绿
- [x] Task 4: 前端共享 API 客户端（新增 apps/web/src/lib/api.ts）
  - [x] SubTask 4.1: `API_BASE`（`PUBLIC_API_BASE` 缺省 `http://localhost:8787/api/v1`）、`credentials:"include"`、错误信封解析、401→`/login?next=`
  - [x] SubTask 4.2: 类型化函数 requestCode / verifyCode / logout / getMe / listWatchItems / createWatchItem / patchWatchItem / deleteWatchItem
- [x] Task 5: login.astro 真实 OTP 流程接线
  - [x] SubTask 5.1: 演示分支（`PUBLIC_DEMO_DATA=1`、123456）原样保留
  - [x] SubTask 5.2: 真实分支：Turnstile widget（sitekey 缺失→表单禁用并提示"人机验证未配置"）→ request-code → verify-code → `?next=` 或 `/watch` 跳转
  - [x] SubTask 5.3: 错误信封映射友好文案（429/401/503）；移除真实分支固定验证码提示
- [x] Task 6: watch/index.astro 列表接线
  - [x] SubTask 6.1: 真实分支加载 `listWatchItems()`，401→登录，空态复用；卡片真实字段 + `auto_monitoring=false` 显示"未开启自动价格监控"徽标；规则相关字段占位"—"不造数
  - [x] SubTask 6.2: 操作：暂停/恢复、删除（保留确认弹窗）、排序（created_at/priority）、分组筛选（group_name 去重）与设置分组
- [x] Task 7: watch/add.astro 添加流程接线
  - [x] SubTask 7.1: 城市（GET /public/cities）→ 类型（房源禁用并注明"需数据来源支持"）→ 对象搜索（regions/communities）→ 可选分组
  - [x] SubTask 7.2: 提交 POST → 按 `auto_monitoring` 展示提示 → 跳回列表；409 提示"该对象已在监控列表中"
- [x] Task 8: 环境与合规收尾
  - [x] SubTask 8.1: `.gitignore` 补 `.dev.vars`；`.env.example` 补 `PUBLIC_API_BASE`、`PUBLIC_TURNSTILE_SITEKEY`（只列名）
- [x] Task 9: 四门禁与浏览器验证
  - [x] SubTask 9.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿
  - [x] SubTask 9.2: 浏览器验证：演示模式行为与 01B 一致；真实模式未登录跳登录、sitekey 缺失禁用提示、add→列表全流程（受限时至少验证 request-code 错误路径）
- [ ] Task 10: 提交与 CI
  - [ ] SubTask 10.1: 中文 commit `TASK-03A: …` → push → 盯 CI 至绿
  - [ ] SubTask 10.2: §12.0 收尾报告（改动摘要/文件/测试/风险/回滚）→ 更新记忆 topics.md

# Task Dependencies

- [Task 2] depends on [Task 1]（分组表存在后才能 JOIN/读写）
- [Task 3] depends on [Task 2]
- [Task 4] depends on [Task 2]（接口契约定型；仅类型对齐，可与 Task 3 并行开发）
- [Task 5 / Task 6 / Task 7] depends on [Task 4]（三者相互独立，可并行）
- [Task 8] 独立，可与 Task 2–7 并行
- [Task 9] depends on [Task 3, 5, 6, 7, 8]
- [Task 10] depends on [Task 9]
