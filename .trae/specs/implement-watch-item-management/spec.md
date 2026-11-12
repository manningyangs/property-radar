# TASK-03A 监控对象管理 Spec

> PRD 任务书 V1.2 · 任务行 1254–1260 · 关联 §2.6 添加监控流程 / §2.7 监控列表 / §9.2 数据模型 / §10.3 用户 API
> 备份 tag：`pre-v1-p2-task-03a`（指向 8ced069，工作区干净）
> 交付范围（用户已确认）：**API + 前端 + 登录全流程接线**

## Why

TASK-02B/02C 已交付 watch-items 的基础 CRUD 与 OTP 登录后端，但前端（01B）仍是纯静态演示 UI、零 fetch 调用，用户无法真正添加/暂停/分组/删除监控对象；PRD 03A 验收（数据隔离、多对象操作、删除后规则按约定停用）尚未有测试覆盖。

## What Changes

- API：`GET /me/watch-items` 新增 `status|object_type|group_name|sort|order` 查询参数；item 响应扩展 `group_name`、`auto_monitoring`。
- API：POST 支持可选 `group_name`，region/community 做目录存在性校验（不存在→404），listing 不校验、`auto_monitoring` 恒 false；去重沿用 UNIQUE→409。
- API：PATCH `status` 枚举扩展 `paused`（暂停/恢复），新增 `group_name`（字符串=upsert、`null`=移出分组）。
- API：`auto_monitoring` 读取时按价格数据批量计算（每类型 1 条 SQL，禁止 N+1），不落库。
- 数据库：Private D1 新增 0003 迁移 `watch_item_groups` 新表（不 ALTER 旧表，保证 up 幂等）；`PRIVATE_TABLES` 14→15。
- 前端：新增共享 API 客户端 `src/lib/api.ts`；login.astro 接真实 OTP 流程（含 Turnstile，未配置则禁用表单绝不放行）；watch/index 真实列表（暂停/恢复/删除/排序/分组筛选）；watch/add 真实添加流程。
- 环境：`.gitignore` 补 `.dev.vars`；`.env.example` 补 `PUBLIC_API_BASE`、`PUBLIC_TURNSTILE_SITEKEY` 名称（只列名不填值）。
- 运行时校验层（实施中发现的 02B/02C 遗留缺陷，经用户确认修复方案）：**Ajv 运行时用 `new Function` 编译 schema，而 Cloudflare Workers/workerd 全局禁用 eval（无兼容开关），导致所有 POST/PATCH 校验端点在真实运行时 500（单测在 Node 中全绿无法暴露）**。方案：`validation.ts` 改为手写 JSON Schema 子集解释器（保留 schemas.ts 全部 schema 数据与 `validateOrThrow` 签名，关键字白名单外直接抛错等价 ajv strict），移除 ajv 依赖；Node 与 Workers 行为一致。
- **BREAKING**：无（演示模式 `PUBLIC_DEMO_DATA=1` 行为保持不变；所有 API 变更均为向后兼容扩展）。

## Impact

- Affected specs: 监控对象管理（03A）、登录全流程接线（02C 前端消费）
- Affected code:
  - `apps/api/src/routes/me.ts`、`apps/api/src/schemas.ts`（及对应测试）
  - `db/migrations/private/0003_watch_item_groups.{up,down}.sql`
  - `packages/migrations/src/index.ts`（PRIVATE_TABLES 清单）+ `index.test.ts`
  - `apps/web/src/lib/api.ts`（新增）、`apps/web/src/pages/login.astro`、`watch/index.astro`、`watch/add.astro`、`src/components/WatchItemCard.astro`
  - `.gitignore`、`.env.example`

## ADDED Requirements

### Requirement: 监控列表查询与筛选排序

系统 SHALL 支持按 `status`（active/paused/archived/all）、`object_type`、`group_name` 筛选，按 `sort`（created_at/priority）与 `order`（asc/desc）排序；每个 item 返回 `group_name` 与 `auto_monitoring`。

#### Scenario: 成功筛选排序

- **WHEN** 已登录用户 `GET /me/watch-items?status=paused&sort=priority&order=desc`
- **THEN** 仅返回该用户暂停状态的对象，按优先级降序，非法参数返回 400 `errors.validation`

#### Scenario: 数据隔离

- **WHEN** 用户 B 请求用户 A 的对象 GET/PATCH/DELETE，或用 `group_name` 筛选
- **THEN** 跨用户对象一律 404，筛选结果不泄漏他人数据

### Requirement: 添加监控对象（含目录校验与去重）

系统 SHALL 在 POST 时校验 region/community 对象存在于 Public DB 目录（不存在→404 `not_found`），不校验数据覆盖（未覆盖对象允许收藏）；listing 不做目录校验；重复对象→409 conflict；支持可选 `group_name`（1–50 字符）创建时入组。

#### Scenario: 未覆盖对象收藏

- **WHEN** 用户收藏目录中存在但尚无价格数据的小区
- **THEN** 创建成功且 `auto_monitoring=false`，前端显示"未开启自动价格监控"徽标

#### Scenario: 去重

- **WHEN** 对同一 (object_type, object_id) 重复 POST
- **THEN** 返回 409 conflict

### Requirement: 暂停/恢复/删除/分组管理

系统 SHALL 通过 PATCH 支持 `status` 在 `active|paused|archived` 间切换；`group_name` 字符串=upsert 分组、`null`=移出分组；DELETE 后关联 `watch_rules`、`watch_item_groups` 行按 FK 级联全部消失。

#### Scenario: 暂停与恢复

- **WHEN** 用户暂停一个对象后再恢复
- **THEN** `status` 往返为 paused→active，筛选 `status=paused` 命中/不命中正确

#### Scenario: 删除后规则停用

- **WHEN** 用户删除一个带规则与分组的监控对象
- **THEN** 其关联 watch_rules 与 watch_item_groups 行全部消失，无孤儿残留

### Requirement: 登录全流程前端接线

系统 SHALL 在演示模式关闭时走真实流程：邮箱 → Turnstile（`PUBLIC_TURNSTILE_SITEKEY` 未配置则表单禁用并提示，绝不放行）→ request-code → verify-code → 按 `?next=` 跳转；401 统一跳 `/login?next=<路径>`；错误信封（429/401/503）映射友好文案。

#### Scenario: 成功登录

- **WHEN** 用户在真实模式输入邮箱与验证码完成登录
- **THEN** 建立 `pr_session` 会话并跳转 `/watch`（或 next），列表显示真实数据

#### Scenario: sitekey 缺失

- **WHEN** 未配置 `PUBLIC_TURNSTILE_SITEKEY`
- **THEN** 表单禁用并提示"人机验证未配置"，不允许提交

## MODIFIED Requirements

### Requirement: watch-items API 请求/响应

`GET /me/watch-items` 在原 `{ items, count }` 基础上新增查询参数与 item 字段（向后兼容）；`POST`/`PATCH` 新增可选 `group_name`；`patchWatchItemSchema.status` 枚举由 `active|archived` 扩展为 `active|paused|archived`。

## REMOVED Requirements

（无）
