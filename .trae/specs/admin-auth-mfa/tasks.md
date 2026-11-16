# TASKS — TASK-06A 后台认证与权限

> 流程：SubTask 全勾后方可收尾 §12.0 报告，实际验收时逐项填写偏差。
> 备份 tag：`pre-v1-p2-task-06a` → c97a70e。

## Task 0：流程启动

- [x] SubTask 0.1：读任务书行 1346–1352（后台认证与权限，阶段 6 管理员后台）+ §8.1 管理员 API 表
      + PRD §8.4 / §2.5 状态表 / §7.6 安全 / §2.1.3 秘钥清单（ADMIN_BOOTSTRAP_CODE）
      + §12.0 执行纪律；AskUserQuestion 三拍板（TOTP / 单角色 / audit 端点归 06A）
- [x] SubTask 0.2：打 tag `pre-v1-p2-task-06a` → c97a70e；写 spec/tasks/checklist 三件套

## Task 1：迁移 0008 与表计数

- [x] SubTask 1.1：`db/migrations/private/0008_admin_mfa.up.sql`（admin_mfa_secrets + admin_mfa_sessions）
      + `.down.sql`（DROP）；不 ALTER 既有表；幂等 IF NOT EXISTS
- [x] SubTask 1.2：`packages/migrations/src/index.test.ts` PRIVATE_TABLE_COUNT 22 → 24（26 tests 过）

## Task 2：TOTP 引擎

- [x] SubTask 2.1：`apps/api/src/totp.ts`——Base32 解码、HMAC-SHA1（WebCrypto）、6位/30s、
      窗口 ±1、generate/verify（verify 返回 step 供防重放）、常量时间比较
- [x] SubTask 2.2：`apps/api/src/totp.test.ts`——RFC 6238 向量、窗口、重放、Base32 边界（12 tests 过）

## Task 3：门禁中间件与错误码

- [x] SubTask 3.1：`errors.ts` 新增 7 错误码（mfa_required/mfa_not_enrolled/mfa_invalid_code/
      mfa_conflict/bootstrap_not_configured/bootstrap_code_invalid/bootstrap_target_not_found）
- [x] SubTask 3.2：`auth.ts` 导出 `requireAdmin` / `requireAdminMfa` / `requireAdminAccess`（bootstrap 与
      mfa/{setup,verify,status} 路径豁免 MFA）；`routes/admin.ts` 改用 `use("*", requireAdminAccess)`

## Task 4：admin-auth 路由

- [x] SubTask 4.1：`schemas.ts` 加 bootstrapAdminSchema / mfaCodeSchema（audit 查询手工解析，见偏差1）
- [x] SubTask 4.2：`routes/admin-auth.ts`——POST /admin/bootstrap（ADMIN_BOOTSTRAP_CODE 常量时间比较、
      未配置 503、email 规范化定位、幂等建角色、审计）
- [x] SubTask 4.3：POST /admin/mfa/{setup,verify,disable} + GET /admin/mfa/status（disable 需已过 MFA +
      body code 双确认；防重放 last_used_step；新登录会话需重验）
- [x] SubTask 4.4：GET /admin/audit（分页 limit ≤200 + action/actor_user_id/resource_type 筛选）
- [x] SubTask 4.5：`app.ts` 挂载（adminRoutes 之后）；`env.ts` 加 ADMIN_BOOTSTRAP_CODE；wrangler.jsonc
      注释列名；`.env.example` 加空值行；`.dev.vars` 加本地 e2e 引导码（gitignore）

## Task 5：审计补写

- [x] SubTask 5.1：`routes/admin.ts` 补 POST /admin/sources → `source.create`、
      PATCH /admin/sources/:id → `source.update`（04A 漏写两处）

## Task 6：测试与验收

- [x] SubTask 6.1：`admin-auth.test.ts`（bootstrap 三态、MFA 流程与门禁、403/401 矩阵、audit 查询，20 tests 过）
- [x] SubTask 6.2：`admin.test.ts` 接入 MFA helper 回归（既有断言不改，22 tests 过）
- [x] SubTask 6.3：四门禁全绿——`npm run typecheck` / `npm run lint` / `npm run test`（247 过，14 文件）
      / `npm run build`（API dry-run + Astro 13 页）
      （偏差2：原写 `pnpm ci`/`test:api`/`test:wrangler` 三个命令仓库不存在，按 §12.0 惯例
        执行 CI 同款四门禁；全量测试另有 pytest 见 CI）
- [x] SubTask 6.4：e2e 脚本 `e2e/admin-auth.mjs`（wrangler dev 真机：401/403 → bootstrap →
      setup/verify → 200 → audit 可查，13 断言两轮全过，端口清理干净）

## Task 7：收尾（§12.0）

- [ ] SubTask 7.1：中文 commit + push + CI 绿（记录 run 编号）
- [ ] SubTask 7.2：记忆更新（topics.md 06A 条目 / project_memory.md 新教训）
- [ ] SubTask 7.3：`docs/TASK-06A-后台认证与权限验收报告.md`
