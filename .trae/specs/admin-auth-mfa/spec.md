# SPEC — TASK-06A 后台认证与权限

> 任务书：`d:\Program Files\download\房价雷达_PRD与Trae开发任务书_V1.2.md` 任务行 1346–1352
> 目标：仅管理员能访问后台 API。独立 admin role、MFA、RBAC、审计日志。
> 验收：普通用户即使直接请求 admin API 也返回 403；所有管理员敏感操作记录日志。
> 备份 tag：`pre-v1-p2-task-06a` → c97a70e。
>
> 拍板（AskUserQuestion，2026-11-16）：
> 1. MFA 形式 = **TOTP 验证器**（RFC 6238，WebCrypto 零新依赖）
> 2. RBAC 粒度 = **单 admin 角色**（保持现状 role='admin'，只补 MFA/审计/bootstrap）
> 3. `GET /admin/audit` 查询端点 = **06A 实现**（修正 04A 注释「查询端点属 06C」）

## 现状（c97a70e）

- `routes/admin.ts:33-43`：内联中间件 `requireSession → admin_roles 活跃角色 → 403 admin_required`，无 MFA。
- `admin_roles` 表（0001）已有 `role/mfa_required/created_by/revoked_at`，无使用方。
- `audit_logs` 表（0001）已有；写入方 source-gate（3 动作）+ admin.ts（approve/suspend/observation）；
  **漏写**：`POST /admin/sources`（登记）、`PATCH /admin/sources/:id`（改元数据）。
- 无管理员创建入口（生产靠 D1 直插）；无 MFA；`GET /admin/audit` 不存在。
- 私库表数 22（`packages/migrations/src/index.test.ts` PRIVATE_TABLE_COUNT）。

## 需求

### R1 TOTP 引擎（`apps/api/src/totp.ts`）

- RFC 6238：SHA-1 HMAC、30s 步长、6 位十进制、动态截断。
- Base32 解码（RFC 4648，容忍无 padding 与小写）。
- `generate(secretBase32, timeMs?)` / `verify(secretBase32, code, timeMs?, window=1)`：
  - 窗口 ±1（当前及前后各 1 步共 3 步容差）；
  - **防重放**：verify 返回通过的 step，调用方与 `last_used_step` 比较，step ≤ last_used 拒绝；
  - 比较用常量时间（无逐字符短路）。
- WebCrypto `crypto.subtle`（HMAC-SHA1），零新依赖。

### R2 迁移 0008（Private，2 新表，不 ALTER——项目惯例）

- `admin_mfa_secrets`：`user_id PK REFERENCES users ON DELETE CASCADE`、`secret_base32 NOT NULL`、
  `confirmed_at NULL`（setup 后未 verify 前为空）、`last_used_step INTEGER NULL`、`created_at`。
- `admin_mfa_sessions`：`session_id PK REFERENCES sessions ON DELETE CASCADE`、`verified_at NOT NULL`。
  会话撤销/过期经 FK 级联 + 查询时 join sessions 校验 `expires_at > now AND revoked_at IS NULL`。
- 幂等 `IF NOT EXISTS`；down 文件 DROP；迁移表计数 22 → 24。

### R3 门禁中间件（`auth.ts` 导出，admin.ts 改用）

- `requireAdmin`：等价现有内联逻辑（401 未登录 / 403 admin_required），结果挂 context。
- `requireAdminMfa`：查 `admin_mfa_sessions`（join sessions 未过期）→ 未过 → **403 `mfa_required`**。
- 挂载：全部 `/admin/*` = requireSession → requireAdmin → requireAdminMfa；
  **豁免 MFA**（仅 requireSession→requireAdmin）：`POST /admin/mfa/setup|verify`、`GET /admin/mfa/status`。
- `POST /admin/bootstrap` 独立（不进 /admin 通配，见 R4）。

### R4 端点（新文件 `routes/admin-auth.ts`，app.ts 挂载）

| 端点 | 门禁 | 行为 |
|---|---|---|
| `POST /admin/bootstrap` | 无登录要求 | body `{bootstrap_code, email}`；`ADMIN_BOOTSTRAP_CODE` 未配置 → 503 `bootstrap_not_configured`；常量时间比较失败 → 403 `bootstrap_code_invalid`；email 找不到用户 → 404 `bootstrap_target_not_found`；INSERT admin_roles（role='admin', mfa_required=1, created_by='bootstrap'，已存在则幂等 200）；写审计 `admin.bootstrap`；响应注明 **code 用后立即撤销** |
| `POST /admin/mfa/setup` | 会话+角色，无 MFA | 已 confirmed → 409 `mfa_conflict`；否则生成 16 字节 secret（base32），upsert 未确认行，返回 `{secret, otpauth_uri}`（otpauth://totp/... issuer=Property Radar）；审计 `admin.mfa.setup` |
| `POST /admin/mfa/verify` | 会话+角色，无 MFA | body `{code}`；无 secret → 403 `mfa_not_enrolled`；TOTP 不过或 step ≤ last_used → 400 `mfa_invalid_code`；confirmed_at 为空则置位；upsert `admin_mfa_sessions`；审计 `admin.mfa.verify`；返回 `{verified:true}` |
| `POST /admin/mfa/disable` | 会话+角色+**MFA** | body `{code}` 再验一次 TOTP（PRD 7.6 关键动作二次确认）→ 删 secret + 删该用户全部 admin_mfa_sessions；审计 `admin.mfa.disable` |
| `GET /admin/mfa/status` | 会话+角色，无 MFA | `{enrolled, confirmed, session_verified}` 供引导 |
| `GET /admin/audit` | 会话+角色+MFA | query `limit(≤200,默认50)/offset/action/actor_user_id/resource_type` → `ORDER BY created_at DESC, audit_id DESC`；返回 `{items, total, limit, offset}` |

### R5 审计补写

- `POST /admin/sources` → `source.create`；`PATCH /admin/sources/:id` → `source.update`（补 04A 漏写）。
- R4 全部状态变更动作：`admin.bootstrap/admin.mfa.setup/admin.mfa.verify/admin.mfa.disable`。
- 读操作（GET 列表类）不写审计。

### R6 配置与错误码

- `env.ts` 加 `ADMIN_BOOTSTRAP_CODE: string | null`（503 条件同 EMAIL_SMTP_* 模式）；
  `wrangler.jsonc` vars 注释列名不写值；`.env.example` 加 `ADMIN_BOOTSTRAP_CODE=`（空=禁用）。
- `errors.ts` 新增：`mfa_required`(403)、`mfa_not_enrolled`(403)、`mfa_invalid_code`(400)、
  `mfa_conflict`(409)、`bootstrap_not_configured`(503)、`bootstrap_code_invalid`(403)、
  `bootstrap_target_not_found`(404)。

### R7 测试与验收

- `totp.test.ts`：RFC 6238 向量（T=59/1111111100 的 6 位取值）、窗口容差、重放拒绝、Base32 边界、常量时间比较。
- `admin-auth.test.ts`：bootstrap 三态（503/403/成功+审计）、setup→verify 全流程、未 verify 访问任意
  admin 端点 403 `mfa_required`、错码/重放 400、disable 双确认、GET /admin/audit 分页筛选、
  普通用户 403、未登录 401。
- `admin.test.ts` 回归：接入 MFA helper（setup+verify 后再测业务），既有断言不改。
- 迁移计数 22→24；`wrangler dev` e2e 脚本 `admin-auth.mjs`（门禁 401/403→MFA→200→audit 可查）。
- 四门禁全绿：`pnpm ci` / `npm run lint` / `npm run test:api` / `pnpm test:wrangler`。

## 验收标准（DoD）

1. 未登录调用任意 /admin/* → 401；普通用户 → 403 `admin_required`；**管理员会话未过 MFA → 403 `mfa_required`**；
2. TOTP setup→verify 后同一会话放行；新登录会话需重新 verify；
3. 所有管理员敏感操作（含 04A 漏写的 source.create/update）在 audit_logs 有行，`GET /admin/audit` 可查可筛；
4. bootstrap：未配置 503 / 错码 403 / 正确码建角色 + 审计；
5. 既有测试零回归；新测试全过；CI 绿。
