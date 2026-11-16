# TASK-06A 后台认证与权限验收报告

> 任务书行 1346–1352（阶段 6 管理员后台）；spec：`.trae/specs/admin-auth-mfa/{spec,tasks,checklist}.md`
> 备份 tag：`pre-v1-p2-task-06a` → c97a70e；交付 commit：**a5210a4**；CI：**run 43791823044 success（#25）**

## 一、拍板决策（AskUserQuestion）

| 决策点 | 拍板结果 |
| --- | --- |
| MFA 形态 | **TOTP 验证器**（RFC 6238，零新依赖 WebCrypto） |
| RBAC | **单 admin 角色**（admin_roles，不建多角色矩阵） |
| GET /admin/audit | **06A 实现**（修正 04A 注释「查询端点属 06C」） |

## 二、交付物

1. **迁移 Private 0008**：`db/migrations/private/0008_admin_mfa.up/.down.sql`
   - `admin_mfa_secrets`（user_id PK/FK CASCADE、secret_base32、confirmed_at、last_used_step）
   - `admin_mfa_sessions`（session_id PK/FK CASCADE、user_id 含 §9.4 user_id 不变量 + 索引）
   - 不 ALTER 既有表、IF NOT EXISTS 幂等；表计数 22 → 24；`apps/api/package.json` db:up/db:apply 已挂 0008
2. **TOTP 引擎** `apps/api/src/totp.ts`：Base32 解码（容忍小写/padding）、HMAC-SHA1（WebCrypto）、6 位/30s、窗口 ±1（三步全算不短路）、`verify` 返回 step 供防重放、常量时间比较、otpauthUri；`generateTotpSecret()` 20 字节 → 32 字符
3. **门禁中间件** `apps/api/src/auth.ts`：
   - `requireAdmin`（活跃 admin_roles，否则 403 `admin_required`）
   - `requireAdminMfa`（admin_mfa_sessions JOIN sessions 未过期未撤销，否则 403 `mfa_required`）
   - `requireAdminAccess`（bootstrap 与 mfa/{setup,verify,status} 路径豁免 MFA；其余会话→角色→MFA 三级）
4. **错误码** `errors.ts` +7：`mfa_required / mfa_not_enrolled / mfa_invalid_code / mfa_conflict / bootstrap_not_configured / bootstrap_code_invalid / bootstrap_target_not_found`
5. **路由** `apps/api/src/routes/admin-auth.ts`：
   - `POST /admin/bootstrap`：无会话要求；未配置 `ADMIN_BOOTSTRAP_CODE` → 503；常量时间 safeEqual；email trim+lowercase 定位；已有角色幂等 200 `created:false`；建角色+审计 → 201 附「立即撤销 code」提示
   - `POST /admin/mfa/setup`：已 confirmed → 409；生成/重置 secret + 审计，返回 `{secret, otpauth_uri}`
   - `POST /admin/mfa/verify`：未绑定 403；错码/`step ≤ last_used_step` 同判 400（重放提示区分文案）；成功 batch 写 confirmed_at + admin_mfa_sessions + 审计
   - `POST /admin/mfa/disable`：requireAdminMfa + body code 双确认；删 secret + 全部会话标记 + 审计
   - `GET /admin/mfa/status`：`{enrolled, confirmed, session_verified}` 三态
   - `GET /admin/audit`：requireAdminMfa；limit 1..200（默认 50）/offset + action/actor_user_id/resource_type 精确筛选（值 >64 字符 400）；COUNT + 分页返回 `{items,total,limit,offset}`
6. **挂载与双保险** `app.ts`：adminAuthRoutes 挂在 adminRoutes 之后（其 `use("*", requireAdminAccess)` 先行匹配豁免规则）；admin-auth 各路由另挂显式 per-route 门禁，不依赖挂载顺序
7. **审计补缺（04A 漏写）** `routes/admin.ts`：POST /admin/sources → `source.create`、PATCH → `source.update`
8. **配置**：`env.ts` `ADMIN_BOOTSTRAP_CODE?`、`wrangler.jsonc` 注释列名、`.env.example` 空值+撤销提示、`apps/api/.dev.vars` 本地 e2e 引导码（gitignore 不入库）

## 三、验收证据

### 任务书验收两条

| 要求 | 证据 |
| --- | --- |
| 普通用户直接请求 admin API 返回 403 | `admin-auth.test.ts` 门禁矩阵 + e2e 断言 2/3（`admin_required`，业务与 audit 端点均 403；未登录 401） |
| 所有管理员敏感操作记录日志 | bootstrap/mfa.setup/verify/disable + source.create/source.update 均落 `audit_logs`（测试断言 action+actor+reason）；GET /admin/audit 可查询 |

### 测试与门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 绿（api 双 tsconfig + web astro check 0 errors） |
| `npm run lint` | 绿（eslint + prettier 全过） |
| `npm run test` | 绿：**14 文件 247 tests**（含新增 admin-auth 20、totp 12、迁移 26、admin 22 回归） |
| `npm run build` | 绿（wrangler deploy --dry-run + Astro 13 页） |
| CI | **run 43791823044 success**（quality + collectors 两 job） |

### 真机 e2e（`e2e/admin-auth.mjs`，wrangler dev :9616）

**13/13 断言两轮全过**（幂等复跑验证）：401 未登录 → 普通用户 403（业务+audit）→ bootstrap 错码 403 / 正确码 201 / 重复 200 幂等 → admin 未过 MFA 403 `mfa_required` → setup 200（32 字符 secret）→ verify 200 → 业务端点 200 → status 三态 true → audit total=3 且 `action=admin.mfa.verify` 精确筛 1 条。收尾 `taskkill /T` 进程树，端口 9616 归零。

## 四、偏差记录

1. **audit 查询 schema 手工解析**：spec 原计划 `auditQuerySchema`，实现中发现 limit 钳制/筛选值长校验与错误信封细节在路由内手工解析更直接，`schemas.ts` 仅落 bootstrap/mfa 两个 schema。
2. **四门禁命令名修正**：tasks/checklist 初稿写 `pnpm ci` / `npm run test:api` / `pnpm test:wrangler`——仓库无对应 script；按 §12.0 惯例执行 CI 同款四门禁（typecheck/lint/test/build），已在 tasks.md 勾选处注明。
3. **email 规范化先于校验**：`EMAIL_PATTERN` 禁空白，bootstrap handler 对 body.email 先 trim 再 `validateOrThrow`（否则带空格的合法邮箱误报 validation_failed）。
4. **本任务未部署生产**：任务书 06A 验收不含部署；生产启用前必须先 `db:apply:private`（0008 两表）再 deploy，并用 `wrangler secret put ADMIN_BOOTSTRAP_CODE` 配码、**建完首个管理员后立即撤销**（缺省未配置 = bootstrap 503 禁用，安全默认）。

## 五、移交

- 部署生产（0008 迁移 + 06A 代码 + ADMIN_BOOTSTRAP_CODE secret）待用户拍板，建议与管理后台 UI（06C）同窗口执行。
- 05C 待办1（真实浏览器推送全链路验证）仍为用户明示的最高优先级搁置项；待办3（WEB_BASE_URL）blocked 等域名拍板。
