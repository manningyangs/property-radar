# 房价雷达 · 上线演练与运维手册（TASK-07C）

> 适用范围：生产环境（Cloudflare Workers + D1 双库 + GitHub Actions 采集 + Google Apps Script 邮件网关）。
> 本手册由 TASK-07C 上线演练（2026-11-16）实测验证，演练证据见 `docs/evidence/07c-01..06`。

## 0. 演练结论索引

| 演练项 | 方式 | 结果 | 证据 |
| --- | --- | --- | --- |
| 数据库备份/恢复 | 生产只读导出 + TEMP 库恢复验证 | PASS | `07c-01-restore-drill.txt` |
| 采集失败降级 | 本地 e2e（job failed → 事件/后台） | PASS | `07c-02-collect-fail-degrade.txt` + 截图 |
| 邮件额度降级 | 本地 e2e（达帽 → deferred/blocked，OTP 不受影响） | PASS | `07c-03-email-quota-degrade.txt` + 截图 |
| 来源一键停用 | 本地 e2e（suspend → 门禁 403 + 审计） | PASS | `07c-04-source-suspend-drill.txt` + 截图 |
| Worker 版本回滚 | 生产真实回滚 + 切回 | PASS | `07c-05-worker-rollback.txt` |
| Pages 前端部署 | 生产只读核实 | 未部署（阻塞项） | `07c-06-pages-check.txt` |

## 1. 数据库备份 SOP（手动，PII 红线）

```powershell
# 前提：wrangler 已登录生产账号；在仓库根目录
node scripts/db-backup.mjs
```

- 产物：`backups/<UTC时间戳>/{public,private}.sql` + `manifest.json`（SHA256、字节数、wrangler 版本）。
- 实现：`wrangler d1 export --remote` 对 `property-radar-public` / `property-radar-private` 双库全量导出。
- **红线：`backups/` 已在 .gitignore，备份含用户 PII，绝不提交 GitHub、绝不放入 CI artifacts**；
  转存只允许加密私有存储（如本人 Google Drive 加密文件夹），保留最近 7 份。
- 频率：开放注册前每次生产迁移/发布前手动执行一次；稳定期建议每周一次。

## 2. 恢复演练 SOP（只进 TEMP，绝不写生产）

```powershell
node scripts/db-restore-drill.mjs
```

流程：备份 SQL 导入临时 sqlite → `PRAGMA integrity_check` → 逐表行数与生产 D1 对账 → 抽样行 SHA256 比对 → 输出 `RESULT: PASS/FAIL`。
演练坑位记录：D1 `--command` 不支持多表 compound SELECT（逐表一条查询）；`--file --json` 只回显汇总不含行数据；远端查询需重试（指数退避）。

### 2.1 生产迁移应用 SOP（本次演练发现 schema 漂移后新增）

生产库曾落后本地 11 个迁移（private 0008–0016、public 0005/0006），已于 2026-11-16 逐个补齐。此后每次发布：

```powershell
cd apps/api
# 标准方式（迁移记录表可用时优先）：
node ..\..\node_modules\wrangler\bin\wrangler.js d1 migrations apply property-radar-private --remote
node ..\..\node_modules\wrangler\bin\wrangler.js d1 migrations apply property-radar-public --remote
# 若迁移台账不可用，退回逐文件方式（幂等 up 文件逐个应用）：
# node ...\wrangler.js d1 execute <DB> --remote --file migrations/00XX-*.sql
```

要求：迁移文件必须 forward-only（先加列后删列）、可重复执行安全；应用后立即跑一次 `db-restore-drill.mjs` 对账。

## 3. 回滚 SOP

### 3.1 Worker 版本回滚（已实测，全程 <20s）

```powershell
cd apps/api
node ...\wrangler.js deployments list            # 查历史版本 ID
node ...\wrangler.js rollback <VERSION_ID> --message "回滚原因" --yes
node ...\wrangler.js deployments status          # 验证 100% 流量已切换
```

- 实测：`96c92dc9… → e305339d… → 96c92dc9…` 两次切换均即时生效（`07c-05`）。
- **注意：版本回滚不会回滚 D1 数据**。若新代码已写入不兼容数据，回滚代码后须按 §2 恢复或前滚修复。
- 数据面验证：`https://manningyangs.property-radar-api.workers.dev/api/health`。
  当前办公网络对 `*.workers.dev` 存在 TLS 阻断（ECONNRESET），需在无阻断网络或 Dashboard Live 上补验。

### 3.2 前端回滚

Pages 尚未部署（见 §7 阻塞项）。部署后回滚走 Pages → Deployments → 历史 production 分支 "Switch to this deployment"。

### 3.3 采集器回滚

`daily-collect.yml` 随代码回滚（GitHub revert + 自动生效）；补跑用 workflow_dispatch 指定 run-date。

## 4. 降级行为与应急处理

### 4.1 采集失败（实测 `07c-02`）

- 行为：`jobs/finish(status=failed)` 落 `ingest_jobs`；来源健康 `down` 落 `source_health_reports`；
  24h 窗口内失败任务/健康 down 触发订阅用户 `data_anomaly` 站内事件（对象城市=任务城市才匹配）；
  后台 `/admin/jobs?status=failed` 可见。
- 应急：Connector 连续失败 → 先查来源站点结构变更；无法快速修复则 §4.3 停用该来源，避免持续消耗额度。

### 4.2 邮件达免费额度（实测 `07c-03`）

- 配额：滚动 24h 硬帽 80 封（`EMAIL_DAILY_HARD_CAP`），OTP 预留 60，通知类上限 20；Apps Script 消费者配额 100 收件人/日。
- 行为：达帽后事件邮件投递行 `status=quota_deferred`（last_error_code=`quota_blocked`）、账本 `quota_blocked`；
  **站内事件不丢**（alert_events 保留，用户可在事件中心查看）；OTP 通道独立可用不受通知影响。
- 应急：额度告急 → 后台确认当日 `email_send_ledger` 计数；必要时暂停 daily_digest（管理员停用来源/关闭摘要）或升级付费邮件服务。

### 4.3 来源被投诉/授权撤销 → 一键停用（实测 `07c-04`）

```
POST /admin/sources/{id}/suspend   body: { "reason": "必填：投诉/撤销依据" }
```

- 行为（全部实测）：license → `suspended`，全部 coverage 行同步 `suspended`，写 `audit_logs(source.suspend)`；
  此后该来源 eligibility/jobs/start/ingest/batch 一律 403 `source_not_approved`；
  历史审批可查 `GET /admin/sources/{id}/approvals`，停用审计可查 `GET /admin/audit?action=source.suspend`。
- 恢复：必须走 `POST /admin/sources/{id}/approve` 重新审批（不提供快捷解封）。

## 5. 免费额度与费用保护核对表

| 资源 | 免费额度 | 本项目用量控制 | 状态 |
| --- | --- | --- | --- |
| Workers 请求 | 10 万次/日 | cron 2 次/日 + 用户流量，初期远低于帽 | ✅ 代码保证 |
| Workers CPU | 10ms/请求（免费版 30s 总） | 无长任务；采集在 Actions 侧 | ✅ 架构保证 |
| D1 | 5GB / 5M 读/日 / 100k 写/日 | 单库 <1MB（备份实测 53KB+69KB） | ✅ 余量巨大 |
| Cron Triggers | 免费 | 2 条（08:30 评估 / 23:30 摘要，北京时间） | ✅ wrangler.jsonc |
| GitHub Actions | 私有仓 2000 分钟/月 | daily-collect 1 次/日 ≤15min（约 30–450 分钟/月） | ✅ timeout 硬限 |
| 邮件（Apps Script） | 100 收件人/日 | 代码硬帽 80/日（预留 20% 缓冲） | ✅ 代码保证 |
| Turnstile | 免费无限 | 仅登录 OTP 前校验 | ✅ |
| Cloudflare 账单 | — | **Dashboard → Billing → Spend Alerts 需手动设置**（见 §7） | ⚠️ 手动项 |

## 6. 应急速查

| 场景 | 动作 |
| --- | --- |
| 数据被误写/损坏 | `db-backup.mjs` 最新备份 → 按 `07c-01` 验证 → 人工评估后决定 D1 重建导入（导出 SQL 中 DROP/CREATE 全量脚本） |
| 新版本代码故障 | §3.1 Worker 回滚（<20s） |
| 来源滥用/投诉 | §4.3 一键停用 |
| 邮件风暴/超帽 | 自动降级已兜底（deferred）；人工核查 ledger 后决定是否暂停摘要 |
| 管理员泄露 | 生产 bootstrap 撤销 `ADMIN_BOOTSTRAP_CODE` secret + `/admin/mfa/disable` |

## 7. 开放注册前硬性检查清单（上线门槛，逐项签字）

1. ☐ **生产创建管理员账号**：本次演练发现生产 `admin_roles` 为 0 行——需 `/admin/bootstrap` 创建 + MFA 绑定，并立即撤销 bootstrap code。
2. ☐ **Pages 前端部署**：创建 Pages 项目、配置 `API_BASE` 生产环境变量、CI 增加部署步骤（当前 `07c-06` 未部署）。
3. ☐ **占位邮箱替换**：`support@` 等占位邮箱换成真实可达邮箱（07B 遗留）。
4. ☐ **Turnstile 生产密钥**：`.dev.vars` 当前为 Cloudflare 测试密钥（恒过），生产必须换正式 sitekey/secret 并挂到 Worker secrets。
5. ☐ **workers.dev 数据面验证**：在无 TLS 阻断网络下 curl `/api/health` 确认 200（本次仅控制面验证）。
6. ☐ **Dashboard Spend Alerts**：Cloudflare 账单页设置消费提醒阈值。
7. ☐ **数据来源跨境/合规核验**：房天下等 portal_listing 来源授权状态人工复核（07B 遗留）。
8. ☐ **法务审阅**：隐私政策/服务条款文本经法务确认（07B 遗留）。
9. ☐ **首次生产备份归档**：`backups/` 最新一份转存加密私有存储。
10. ☐ **生产迁移台账核对**：`d1 migrations list --remote` 双库均无 pending。
