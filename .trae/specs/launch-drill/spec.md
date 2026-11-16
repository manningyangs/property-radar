# TASK-07C 上线演练 Spec

**任务书依据**：§12 行 1386–1393（六项演练）+ 行 1395（最终上线门槛核对）。
**基线**：tag `pre-v1-p2-task-07c`（c60da62）。

## 0. 拍板决策（2026-11-16 AskUserQuestion 全选推荐）

1. **环境与深度**：混合演练——备份导出/恢复验证、Worker 版本回滚在生产真实操作（恢复只进本地临时文件，绝不覆盖生产库；回滚演练后切回最新）；降级与停用链路本地 e2e 全验；费用保护生产只读核对。
2. **备份形态**：手动脚本 + 文档（`scripts/db-backup.mjs`），备份落 `backups/`（gitignore），PII 不出本机、不进 GitHub。
3. **07B 遗留项**（占位邮箱/Turnstile 生产密钥/跨境核验）：列为「开放注册前硬性检查清单」进验收报告，本轮不替换。
4. **Worker 回滚**：真实演练（deployments 基线 → rollback → 健康验证 → 切回 → 健康验证）。

## 1. 现状盘点（探查结论）

| 演练项 | 现状 | 缺口 |
|---|---|---|
| 备份/恢复 | 无任何脚本/文档 | 全新建 |
| 采集失败降级 | source-gate 四段门禁、job failed+health down、/admin/jobs（04D/06D） | 缺一次端到端真实演练留痕 |
| 邮件额度降级 | quota.ts 80/24h 硬帽、quota_deferred/blocked、站内保留（05B） | 缺达限场景实测 |
| 一键停用 | admin suspend API + connector 自动阻止（06C） | 缺 suspend→run_daily→零采集 全链路实测 |
| 回滚 | migrations down 链测试全覆盖（down→down→up）；Worker 回滚仅文档（05A 报告 L107-110） | Worker versions 真实演练未做；前端 Pages 部署方式待核（00A 时 Pages 项目=0） |
| 费用保护 | cron：Worker 2 条/日 + daily-collect 1 次/日；EMAIL_DAILY_HARD_CAP=80 | 无 Cloudflare 账单/spend alerts 核对文档 |

## 2. 设计

### 2.1 备份脚本 `scripts/db-backup.mjs`
- `node scripts/db-backup.mjs`：对 radar_public/radar_private 依次执行 `wrangler d1 export <db> --remote --output backups/<UTC日期>/<db>.sql`（经 execFileSync 数组传参，同 04C 先例）。
- 导出后生成 `manifest.json`：文件 SHA256、字节数、导出时间、wrangler 版本。
- 退出码非 0 = 失败；日志不含任何行数据。
- `backups/` 进 .gitignore（PII）。

### 2.2 恢复演练 `scripts/db-restore-drill.mjs`
- 读取最新 `backups/<date>/` 的 SQL，用 `node:sqlite` 导入**本地临时文件**（`%TEMP%/pr07c-restore-*.sqlite`，绝不碰生产/本地 dev 库）。
- 验证三件套：`PRAGMA integrity_check`；核心表行数与生产 `SELECT COUNT(*)`（wrangler d1 execute --remote 只读查询）对比一致；抽样行（最新 users、price_snapshots、audit_logs 各 1 行）字段一致。
- 输出 PASS/FAIL 报告落 `docs/evidence/07c-01-restore-drill.txt`。
- 生产库恢复步骤（`wrangler d1 execute --remote --file`）只写 runbook，不实跑。

### 2.3 本地 e2e 三项降级/停用演练（脚本 `scripts/drill-degrade.mjs` 或 Temp 一次性脚本，模式同 pr07b-e2e.mjs）
- **采集失败**：向本地 ingest 提交畸形/超频批次或模拟 connector 失败 → 断言 ingest_jobs.status=failed、source_health_reports=down、系统事件生成、/admin/jobs 可见；run_guard 在未 approved 来源上零采集请求。
- **邮件额度**：直插 email_send_ledger 使 24h sent=80 → 触发 digest/事件邮件 → 断言投递行 quota_deferred、账本 quota_blocked、站内事件正常、OTP 仍可发（预留 60 帽独立）。
- **一键停用**：admin suspend 来源 → eligibility 403（run_guard 阻断）→ 回放 run_daily → 零新观测/零新批次；审批历史保留（append-only）。
- 证据：日志 + 截图（admin 页面）落 docs/evidence/07c-02..04。

### 2.4 Worker 版本回滚真实演练（生产）
- 基线：`curl` 生产 API 健康端点 + `wrangler deployments list` 记录当前 version id。
- `wrangler rollback`（回上一部署）→ 健康验证（旧版本应答，记录响应差异）→ `wrangler rollback <最新deployment>` 切回 → 健康验证 + deployments list 复核。
- 全程命令与输出落 `docs/evidence/07c-05-worker-rollback.txt`。演练窗口选邀请制低峰（当前无真实用户流量，报告如实记录耗时与风险）。

### 2.5 D1 迁移回滚
- 引用 migrations 测试（down→down→up 可重复，27 用例）作为能力证据；runbook 写生产「前进式修复优先、down 链仅最后手段」的操作顺序与命令。

### 2.6 前端回滚
- 核实 Pages 项目是否已创建/部署（CF REST API `pages/projects`，token 走 gh secret/环境变量，不落日志）。
- 已部署 → runbook 写 Pages deployment 回滚（dashboard/CLI 提升上一 deployment）；未部署 → 列入上线阻塞项（Pages 项目创建 + 首次部署 + 回滚演练补做）。

### 2.7 免费额度与费用保护核对
- 统计当前固定负载：Worker cron 2/日（08:30 事件评估、07:30 摘要）、daily-collect 1/日、Apps Script 邮件 ≤80/日（硬帽）、请求量估算（邀请制）。对照 Cloudflare Workers Free（10 万请求/日）、D1 Free（5M 行读/日）、Apps Script 配额。
- 输出核对表进 runbook + 报告；Cloudflare dashboard 侧动作（Billing → spend alerts、设置用量提醒）列为负责人手动项进阻塞清单（无 API 可代做）。

### 2.8 交付物
- `scripts/db-backup.mjs`、`scripts/db-restore-drill.mjs`（进 eslint/prettier glob，须过 lint）
- `.gitignore` 补 `backups/`
- `docs/OPERATIONS-上线演练手册.md`（备份/恢复/回滚/停用/降级/应急 runbook）
- `docs/TASK-07C-上线演练验收报告.md`（含行 1395 上线门槛逐项核对表 + 开放注册前硬性检查清单）
- `docs/evidence/07c-01..06-*`

## 3. 门禁与验收

- 四门禁：typecheck / lint / test / build（新脚本不得破坏 lint）。
- 上线门槛（任务书 1395）逐项核对：核心数据真实、合法授权、来源可追溯；用户隔离+管理员权限（引 07A）；无未授权爬虫（引 07B）；无明文密钥（引 07A secrets-scan）；价格口径不混淆（引 04E）。
- 演练失败即修复或如实记录为阻塞项，不得假绿。

## 4. 红线

- 恢复演练绝不写生产库/本地 dev 库（只进 TEMP 临时文件）。
- 备份 SQL 与导出日志不入 git、不进 CI artifacts。
- Worker 回滚演练后必须切回最新版本并二次验证。
- 生产 API token 不落任何文件/日志。
