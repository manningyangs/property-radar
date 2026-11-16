# TASK-07A 安全测试验收报告

- 任务书行 1378–1380：覆盖 IDOR、CSRF、XSS、SQL Injection、SSRF、OTP 暴力破解、邮箱枚举、session fixation、管理员越权、Secrets 泄露检查、CORS、错误日志泄露
- 上线门槛（任务书 1395）：用户隔离和管理员权限测试通过；没有明文密钥进入仓库
- 交付 commit：`37e6a82`（12 文件，+1533/−5）；CI run `43814149640` success（quality / **secrets-scan** / collectors 三 job 全绿）；基线 tag `pre-v1-p2-task-07a`（607e4c3）
- 规格三件套：`.trae/specs/security-test-suite/`（spec / tasks / checklist，本报告随收尾提交勾选）
- 性质说明：本任务为纯 API/安全测试交付，无 UI 变更，证据为测试与扫描运行记录（`docs/evidence/07a-01..04`），不适用浏览器截图

## 一、拍板决策（AskUserQuestion，用户全选推荐项）

1. 测试载体：新增专项套件 `apps/api/src/security.test.ts`，12 项逐条可回归断言（已有覆盖项补专项断言形成完整证据链）
2. Secrets 门禁：CI 常驻（`scripts/check-secrets.mjs` + ci.yml `secrets-scan` job）+ 本次全仓/全历史扫描
3. 漏洞处置：测试发现真实漏洞本任务内直接修复 + 回归断言

## 二、12 项测试结果（32 用例全绿，证据 07a-01）

| # | 项目 | 关键断言 | 结果 |
|---|------|----------|------|
| 1 | IDOR | B 访问 A 的 watch/rule/event/subscription 六端点全 404；写端点 body 传 `user_id` 被 strict schema 拒 400（归属只从 session 解析） | PASS |
| 2 | CSRF | 会话 cookie 恒 `HttpOnly; Secure; SameSite=Lax; Path=/`；跨站 Origin 无 cookie 写请求 401 且响应零 CORS 放行头；写语义不挂 GET | PASS |
| 3 | XSS | `<script>`/`onerror` 串经 watch 字段存储回读均为原样文本；响应恒 `application/json`；错误信封不回显 HTML | PASS |
| 4 | SQL Injection | 4 类注入串打路径/查询串/body → 400/404；users/sessions 表完好、登录链路仍正常（prepared statements 实证） | PASS |
| 5 | SSRF | 管理员 `official_url` 填元数据/回环地址仅存储、零外部 fetch；推送 endpoint 强制 https + 私网黑名单（修复见 §三）；认证链路外部调用 host 白名单（challenges.cloudflare.com + Apps Script 桩） | PASS |
| 6 | OTP 暴力破解 | 同码 5 错锁定后**正确码也被拒**（429）；同邮箱 60 秒冷却 429 | PASS |
| 7 | 邮箱枚举 | request-code 存在/不存在邮箱 status+body 字节级一致；verify-code 无 OTP 与错码 error_code+message 一致 | PASS |
| 8 | Session fixation | 登录请求预置伪造 `pr_session` 不被沿用：签发新随机 token、伪造值恒 401；两次登录 token 不同；logout 只撤当前会话 | PASS |
| 9 | 管理员越权 | 6 个 admin 端点组门禁矩阵：未登录 401 / 普通用户 403 `admin_required` / 管理员未过 MFA 403 `mfa_required`；伪装 `X-Admin` 头无效 | PASS |
| 10 | Secrets 泄露 | env 注入 6 个哨兵密钥值，全部正常/错误/internal 签名失败/500 响应体均不含哨兵 | PASS |
| 11 | CORS | 白名单精确回显 + credentials；非白名单与 `null` Origin 零放行头；任何响应不出现 `ACAO: *`；预检 204 | PASS |
| 12 | 错误日志泄露 | 存储故障 → 500 信封仅 `internal_error`+request_id，无 SQL/表名/stack；访问日志序列化不含会话 cookie 值、OTP、哨兵 | PASS |

## 三、发现并修复的真实漏洞（1 个）

**推送订阅 endpoint SSRF（中危）**：`POST /me/push-subscriptions` 此前接受任意 `http(s)` URL（含 `127.0.0.1`、`169.254.169.254`、`localhost`、私网段），而服务端 `sendPush` 会直接 `fetch(endpoint)` 投递——用户可把 Worker 用作对内网/元数据地址的 POST 请求代理，违反 PRD §7.6「服务器不得任意 fetch 用户提交 URL」。

修复（commit `37e6a82`）：
- `schemas.ts`：endpoint pattern 收紧为 `^https://`
- `routes/me.ts`：URL 语义校验拒绝 IPv4/IPv6 字面量、回环/链路本地/10/172.16-31/192.168 私网段、`localhost` 与 `.local/.internal/.localdomain/.lan/.home` 后缀、单标签主机名
- 回归：10 个恶意 endpoint 形态全 400、公网 https 域名 201（security.test.ts §5）；push.test.ts / me.test.ts 既有 44+14 用例不受影响

已知边界（如实记录）：Workers 运行于 Cloudflare 边缘，无法对域名做 DNS 解析级私网拦截（rebinding 理论面）；但边缘网络不可达用户内网，且响应不回传用户、payload 为加密 push，残余风险低。07C 上线检查清单可补充 Cloudflare 出站限制选项评估。

## 四、Secrets 泄露检查实证（证据 07a-03/04）

- 工作树：`scripts/check-secrets.mjs` 扫描 287 个 git 跟踪文本文件 → **PASS**（HARD：私钥块/GitHub/AWS/Slack/OpenAI/Stripe/Google 形态；SOFT：生产代码 secret 高熵赋值，测试/文档豁免）
- 全历史：36 commits diff 扫描零命中
- `apps/api/.dev.vars` 确认被 gitignore（`git check-ignore` 命中）
- CI 常驻：`secrets-scan` job 已在本次 CI 实际 success，此后每次 push 防回归

## 五、质量门禁

- typecheck / lint / test / build 四门禁全绿；全量测试 **api 318**（286+32 新增）+ shared 18 + migrations 26 用例通过；build 16 页
- CI run `43814149640`：quality / secrets-scan / collectors 全 success

## 六、结论

任务书 1380 的 12 项覆盖全部有自动化用例实证并入 CI 回归；上线门槛两项（用户隔离+管理员权限测试通过、无明文密钥进仓库）达成；发现并修复 1 个真实 SSRF 漏洞。TASK-07A 验收通过。
