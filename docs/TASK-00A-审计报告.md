# TASK-00A 仓库与现状审计报告

**审计日期：** 2026-11-11
**审计人：** Trae 开发助手
**依据：** 《房价雷达 PRD 与 Trae 开发任务书 V1.2》§12 阶段 0 TASK-00A
**结论：** 工作区为全新空目录，无历史代码、无密钥泄露面、无既有部署流程；GitHub 与 Cloudflare 账号可用，具备从零建仓条件。

---

## 1. 工作区现状

| 项 | 结果 |
|---|---|
| 目录 | `e:\desktop\home_search`（空目录，无任何文件） |
| Git 仓库 | 无（审计时点后由本任务初始化为 `main` 分支） |
| 历史业务代码 | 无 |
| 构建产物 / 日志 | 无 |
| CI 工作流 | 无 |
| 已有 Secrets / 密钥文件 | 无（目录为空，无泄露面） |

**回滚点：** 本报告所在 commit 即项目基线（初始 commit）；如需回滚，`git checkout <本 commit SHA>` 即回到审计时点状态。

## 2. GitHub 现状

- **账号：** `manningyangs`（github_id 232753758），gh CLI 已登录（keyring），scopes：`repo`、`workflow`、`gist`、`read:org`。
- **git 凭证：** Windows credential manager 已存 github.com 凭证，`git ls-remote` 实测可用。
- **gh CLI 路径：** `C:\Program Files\GitHub CLI\gh.exe`（PATH 中可能不存在，须全路径调用）。
- **既有仓库清单（与本项目无关，仅审计记录）：**

| 仓库 | 可见性 |
|---|---|
| AI-Shovel-Collection | PUBLIC |
| ai-workflow-lab | PRIVATE |
| Wechatsync | PUBLIC |
| ComfyUI_Time_Machine | PUBLIC |
| MovieMagnetSearch-Android | PUBLIC |
| MovieMagnetSearch | PUBLIC |

- **本项目仓库：** 尚不存在，将在 TASK-01A 创建为 **Private**。
- **既有 Workflow / Actions：** 上述仓库的 workflow 属其他项目，本项目不复用；本项目 CI 在 TASK-01A 按最小 `permissions` 新建。
- **Secrets 名称：** 本项目仓库尚不存在，无 Repository-level secrets；（其他仓库的 secrets 未查询值，审计不触碰。）
- **历史密钥泄露检查：** 本项目无历史提交、无构建产物，无泄露面；后续每个提交前须复查 `git diff` 无密钥。

## 3. Cloudflare 现状

- **登录方式：** Wrangler OAuth Token，凭据文件 `C:\Users\Home-pc\AppData\Roaming\xdg.config\.wrangler\config\default.toml`（本报告不包含 token 值）。
- **账号：** `Yang1_75@126.com's Account`，Account ID `e9795330197c4498bde9bc255e24e210`。
- **Token scopes：** `user(read)`、`account(read)`、`workers(write)`、`workers_kv(write)`、`workers_routes(write)`、`workers_scripts(write)`、`workers_tail(read)`、`d1(write)`、`pages(write)`、`zone(read)`、`ssl_certs(write)` 等（另有一批 k2/ai-search 等未授权 scope，本项目 V1 不需要）。
- **既有 D1 数据库（属其他项目，不复用）：**

| 数据库 | uuid | 用途归属 |
|---|---|---|
| AI_WORKFLOW_DB | ee6f1a5e-61a5-4f20-96c7-9f116a2dad56 | ai-workflow-lab 项目 |
| ai-shovel-eval | 4772ebff-fa28-48a3-9fe7-12726f10fa50 | AI-Shovel-Collection 项目 |

- **Pages 项目：** 0 个（`pages/projects` REST API 查询结果为空）→ 本项目可独占创建 `property-radar` Pages 项目。
- **部署目标与回滚点：** 尚无本项目部署；TASK-01A/02 阶段部署后，Wrangler 版本历史即回滚点（`wrangler rollback`）。
- **免费额度保护：** 现有用量集中在其他项目；本项目新建资源前按 PRD §6.8 启用预算保护（超额是报错不是扣费，但仍按 PRD 要求显式设上限）。

## 4. 工具链现状

| 工具 | 版本/状态 | 备注 |
|---|---|---|
| Windows PowerShell | 5.1 | 终端 shell |
| git | 2.47.1.windows.1 | 全局配置：`http(s).proxy=127.0.0.1:7897`、`http.sslverify=false`、`safe.directory=*` |
| Node.js | 22.20.0 便携版 | 须设 PATH：`e:\desktop\wechat_sync\.tools\node-v22.20.0-win-x64` |
| pnpm | 9.15.9 | 随便携版工具链 |
| Wrangler | 4.160.0 | 已登录 |
| gh CLI | 已登录 | 全路径调用 |

## 5. 网络现状与已知风险

1. 本地代理 `127.0.0.1:7897` 在线；curl/git/gh 实测 GitHub、Cloudflare API 均可达。
2. **沙盒限制：** 出站请求（OAuth、部分 curl）可能被沙盒拦截，需 `dangerouslyDisableSandbox: true` 执行外网命令（与前一项目经验一致）。
3. **wrangler pages 子命令**直连 `fetch failed`（网络瞬时问题）；改用 REST API + `curl -4` 查询成功——后续部署阶段如复现按此绕行。
4. **并发两个 `npx` 会损坏 npm `_npx` 缓存**（本次已清理 `C:\Users\Home-pc\AppData\Local\npm-cache\_npx`）；此后避免并行 npx。
5. `wrangler whoami` 偶发报 token 过期 + 认证服务器不可达——多为瞬时网络问题，重试即可，凭证未受损。

## 6. 环境变量 / Secrets 计划（名称，不含值）

按 PRD 附录 A，本项目后续将新增（本任务不创建）：

- Worker Secrets：`OTP_PEPPER`、`MAIL_GATEWAY_TOKEN`、`ADMIN_BOOTSTRAP_TOKEN` 等（TASK-02C 起）。
- GitHub Actions Repository-level secrets：不依赖 Environment secrets（GitHub Free 限制）。
- 前端/仓库内**禁止**出现任何真实密钥；`.env` / `.dev.vars*` 已在 `.gitignore` 中排除。

## 7. 审计结论

- 无既有业务代码与部署流程需要保护，"不破坏现有项目"约束自然满足。
- GitHub Private 建仓、Cloudflare Workers/D1/Pages 创建所需账号与权限全部就绪且在免费额度内。
- 无密钥泄露面；风险清单（§5）已记录，后续任务执行前须复核。
- **TASK-00A 验收：通过。** 下一步：TASK-00B（城市目录与数据源可行性验证）。
