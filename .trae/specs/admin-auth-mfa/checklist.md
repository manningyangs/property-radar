# CHECKLIST — TASK-06A 后台认证与权限（验收门禁）

> 全部勾选后方可打「06A 完成」结论并写 §12.0 报告。

## 迁移与表

- [x] `db/migrations/private/0008_admin_mfa.up.sql`：admin_mfa_secrets + admin_mfa_sessions，
      幂等 IF NOT EXISTS、FK CASCADE 正确、未 ALTER 既有表（含 §9.4 user_id 不变量）
- [x] `.down.sql`：两表 DROP（含索引），与 up 对称
- [x] 迁移表计数 22 → 24（`packages/migrations/src/index.test.ts`，26 tests 过）

## TOTP

- [x] `totp.ts`：RFC 6238 SHA-1/6位/30s；窗口 ±1；防重放（step ≤ last_used 拒绝）；
      常量时间比较；零新依赖（WebCrypto）
- [x] `totp.test.ts`：RFC 向量 / 窗口 / 重放 / Base32 边界全过（12 tests）

## 门禁

- [x] 未登录任意 /admin/* → 401
- [x] 普通用户 → 403 `admin_required`
- [x] 管理员会话未过 MFA → 403 `mfa_required`（全部业务端点）
- [x] setup/verify/status 仅豁免 MFA，仍需会话+角色（bootstrap 无会话）
- [x] 新登录会话需重新 verify（session 级标记，FK CASCADE）

## 端点

- [x] POST /admin/bootstrap：未配置 503 / 错码 403 / 正确码建角色 + 审计 + 响应提示撤销 code（幂等 200）
- [x] POST /admin/mfa/setup：已 confirmed 409；返回 secret + otpauth_uri + 审计
- [x] POST /admin/mfa/verify：无 secret 403 mfa_not_enrolled；错码/重放 400；confirmed + session 标记 + 审计
- [x] POST /admin/mfa/disable：需 MFA + body code 双确认；清理 secret 与全部 session 标记 + 审计
- [x] GET /admin/audit：分页（≤200）+ action/actor_user_id/resource_type 筛选 + 403 门禁

## 审计

- [x] source.create / source.update 两处漏写已补
- [x] admin.bootstrap / admin.mfa.setup / admin.mfa.verify / admin.mfa.disable 有审计行

## 配置

- [x] env.ts ADMIN_BOOTSTRAP_CODE（缺省 → 503）；wrangler.jsonc 只注释列名；.env.example 空值 + 撤销提示；
      .dev.vars 本地 e2e 引导码（gitignore，不入库）

## 测试与 CI

- [x] `admin-auth.test.ts` 新增用例全过（20 tests）
- [x] `admin.test.ts` 回归通过（接入 MFA helper，既有断言未改，22 tests）
- [x] 四门禁全绿：`npm run typecheck` / `npm run lint` / `npm run test`（247）/ `npm run build`
      （偏差：原写 `pnpm ci`/`test:api`/`test:wrangler` 仓库无此命令，按 CI 同款执行）
- [x] e2e `e2e/admin-auth.mjs`：wrangler dev 真机 13 断言两轮全过
- [x] 中文 commit a5210a4 + push + CI 绿（run 43791823044 success #25）

## 记忆与文档

- [x] topics.md 06A 完成条目
- [x] project_memory.md 新教训（7 条）
- [x] `docs/TASK-06A-后台认证与权限验收报告.md`（含 4 条偏差记录）
