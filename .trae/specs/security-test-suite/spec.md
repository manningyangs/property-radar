# TASK-07A 安全测试 Spec

任务书 §12 TASK-07A（行 1378–1380）：覆盖 IDOR、CSRF、XSS、SQL Injection、SSRF、OTP 暴力破解、邮箱枚举、session fixation、管理员越权、Secrets 泄露检查、CORS、错误日志泄露。
最终上线门槛（1395）：用户隔离和管理员权限测试通过；没有明文密钥进入仓库。

## R1 安全测试专项套件（apps/api/src/security.test.ts）

12 项逐条可回归断言（已有覆盖项在本套件补充专项断言形成完整证据链）：

1. **IDOR**：用户 B 持自己会话访问 A 的 watch_id / rule_id / event_id / subscription_id 一律 404；私有写端点 body 携带 `user_id` 字段被 strict schema 拒 400（归属只从 session 解析，PRD §7.4）。
2. **CSRF**：会话 cookie 属性恒为 `HttpOnly; Secure; SameSite=Lax; Path=/`；非白名单跨站 Origin 不获得任何 CORS 凭证头；写操作端点（POST/PATCH/DELETE）不接受 GET 语义触发；无 cookie 请求 /me/* 恒 401。
3. **XSS**：`<script>` / `<img onerror>` 等恶意串经 watch remark、name 等字段存储与回读均为原样文本；API 响应 Content-Type 恒为 `application/json`；错误信封为 JSON 不回显 HTML。
4. **SQL Injection**：注入串（`' OR '1'='1`、`; DROP TABLE users;--`、`1; DELETE FROM sessions`）打入路径参数、查询串、JSON body → 400/404；攻击后表结构与数据完好、正常查询仍可用。
5. **SSRF**：全请求生命周期内除固定 env 外部调用（Turnstile siteverify、Apps Script 网关）外不发生任何 fetch；管理员把 source `official_url` 填 `http://169.254.169.254` / `http://127.0.0.1:8789` 仅原样存储，服务端绝不抓取（PRD §7.6：Source URL 不允许服务器任意 fetch）。
6. **OTP 暴力破解**：同码 5 次错误后锁定，此后正确码也被拒；同邮箱 60 秒冷却、15 分钟窗口超频 429。
7. **邮箱枚举**：request-code 对已存在/不存在邮箱的 status、body、message 字节级一致；verify-code 对"不存在邮箱"与"错误码"文案一致。
8. **Session fixation**：登录成功必发新随机 token（Set-Cookie 值 ≠ 客户端预先塞入的任何 cookie 值）；未认证时客户端伪造的 `pr_session` 不被沿用为会话凭证；logout 后旧 token 立即失效（401）；两次登录 token 互不相同。
9. **管理员越权**：门禁矩阵——未登录 401 / 普通用户 403 admin_required / 管理员未过 MFA 403 mfa_required，覆盖 admin 各端点组（sources、users、overview、jobs、quality、audit）。
10. **Secrets 泄露**：给 env 填入可识别哨兵值（SESSION_SIGNING_SECRET、INGEST_HMAC_SECRET、APPS_SCRIPT_HMAC_SECRET、TURNSTILE_SECRET_KEY、ADMIN_BOOTSTRAP_CODE、VAPID_PRIVATE_KEY），扫描全部端点响应体，任何响应不得含哨兵值；internal 端点错误也不泄露密钥材料。
11. **CORS**：白名单 Origin 回显 + credentials；非白名单 Origin 零 CORS 头；任何情况下不出现 `Access-Control-Allow-Origin: *` 与 credentials 组合；OPTIONS 预检 204。
12. **错误日志泄露**：内部异常（注入 D1 故障）→ 500 信封仅 `internal_error` + request_id，不含 SQL、表名、stack、err.message；访问日志序列化不含 cookie 头、OTP 码、响应体。

## R2 CI 常驻 Secrets 门禁

- `scripts/check-secrets.mjs`：纯 Node 无依赖；扫描 git 跟踪文件（文本），规则：私钥块（`BEGIN ... PRIVATE KEY`）、`ghp_`/`github_pat_`/`cloudflare` 长 token 形态、明显 secret 赋值高置信模式；命中即 exit 1 并列出行号。
- 白名单机制：测试桩值（`test-session-secret` 等）与哨兵值不属真密钥格式，规则设计避免误报；docs 中脱敏样例不受影响。
- `.github/workflows/ci.yml` 新增 `secrets-scan` job（permissions: contents: read，checkout persist-credentials: false），先于 quality 独立跑。

## R3 漏洞处置

测试发现真实可利用漏洞 → 本任务内修复 + 回归断言 + 报告记录；无漏洞则记录"未发现"。

## R4 验收证据与报告

- `docs/TASK-07A-安全测试验收报告.md`：12 项逐条结果表（用例名、断言、结论）、Secrets 扫描输出、修复记录（如有）。
- `docs/evidence/07a-*`：security 套件运行输出、全量测试输出、secrets 扫描输出（纯 API 任务，无 UI 变更，证据为文本运行记录而非浏览器截图）。

## R5 质量门禁

四门禁全绿（typecheck/lint/test/build）；security.test.ts 并入 vitest 全量；commit/push 后 CI success。

## 约束

- 不改生产行为语义；修复仅限证实的漏洞。
- 测试数据全虚构（example.com）；哨兵值仅存在于测试内存 env。
- 任务书 md 副本（工作区根目录）不提交。
