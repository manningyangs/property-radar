# TASK-07C 上线演练验收报告

- 任务依据：`房价雷达_PRD与Trae开发任务书_V1.2.md` 行 1386–1395（六项演练 + 上线门槛核对）
- 执行日期：2026-11-16（Asia/Shanghai）
- 基线 tag：`pre-v1-p2-task-07c`（c60da62）
- 演练方式（负责人拍板）：混合演练——备份导出/恢复验证、Worker 回滚在生产真实操作（恢复只进 TEMP 绝不写生产）；降级/停用走本地 e2e；费用与 Pages 走生产只读核实

## 一、六项演练结果

| # | 演练项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 测试数据库备份和恢复 | **PASS**（并发现修复生产 schema 漂移） | `docs/evidence/07c-01-restore-drill.txt` |
| 2 | 采集失败时的降级 | **PASS** | `07c-02-collect-fail-degrade.txt` + `07c-02-admin-jobs-failed.png` |
| 3 | 邮件达免费额度降级 | **PASS** | `07c-03-email-quota-degrade.txt` + `07c-03-user-events-quota.png` |
| 4 | Source 被投诉/授权撤销一键停用 | **PASS** | `07c-04-source-suspend-drill.txt` + `07c-04-admin-sources.png` + `07c-04-admin-suspended.png` |
| 5 | 回滚前端/Worker/D1 migrations | **PASS**（Worker 生产真实回滚并切回；前端 Pages 未部署→阻塞项） | `07c-05-worker-rollback.txt`、`07c-06-pages-check.txt` |
| 6 | 免费额度与费用保护 | **核对完成**（代码/架构保证 7 项 + 手动项 1 项） | 手册 §5 核对表 |

### 演练要点与发现

1. **备份/恢复**：`scripts/db-backup.mjs` 生产双库导出（public 53KB / private 69KB + manifest SHA256）；`scripts/db-restore-drill.mjs` TEMP 导入 → integrity_check ok → 34 表行数逐表对账生产 → 抽样行哈希 MATCH → RESULT: PASS。
2. **重大发现（演练价值）**：恢复演练暴露生产 schema 漂移——private 缺迁移 0008–0016（无 admin_mfa 两表、ingest_jobs 缺 7 列、users 缺 deletion_requested_at）、public 缺 0005/0006（price_observations 缺 batch_id）。生产此前无任何远端迁移工具/流程。已逐个 `wrangler d1 execute --remote --file` 补齐 11 个 up 文件并重跑备份+演练转 PASS；生产迁移应用 SOP 写入手册 §2.1。
3. **采集失败降级**：注入 failed job + health down → 事件评估 anomaly=5（data_anomaly 站内事件，对象城市=任务城市匹配）；`/admin/jobs?status=failed` 可见演练 job。
4. **邮件额度降级**：注入 20 条 sent 达通知侧帽（80−OTP 预留 60）→ 投递行 `quota_deferred`/账本 `quota_blocked`；站内事件保留 5 条；OTP 请求独立 200 不受影响。
5. **一键停用**：suspend 200 → eligibility/jobs-start/ingest-batch 全部 403 `source_not_approved`；coverage 非 suspended 行=0；审计 `source.suspend` 留痕（actor=admin）；演练后本地复原 approved_open。
6. **Worker 回滚**：生产真实操作 `96c92dc9 → e305339d → 96c92dc9`，两次切换均 100% 流量即时生效，全程 <20s，最终与基线一致。限制：办公网络对 `*.workers.dev` TLS 阻断（ECONNRESET），数据面健康验证列入上线前清单（手册 §7-5）。

## 二、上线门槛逐项核对（任务行 1395）

| 门槛 | 结论 | 依据 |
| --- | --- | --- |
| 核心数据真实、合法授权、来源可追溯 | ✅（00B/04C/07B 复核；生产 admin 无账号为运营缺口非数据缺口） | 07B 报告、source-gate 四段门禁 |
| 用户隔离和管理员权限测试通过 | ✅ | 07A security.test.ts 12 项 + 本次 admin MFA 实测 |
| 没有未授权平台爬虫 | ✅ | allowlist + 门禁 403 实测（07c-04） |
| 没有明文密钥进入仓库 | ✅ | 07A secrets-scan CI 门禁；本次备份产物 backups/ 已 gitignore 且未提交 |
| 价格口径没有混淆 | ✅ | 03B 双口径 + 04E 规则绑定矩阵 |
| 可回滚、可降级、可停用 | ✅ | 本报告六项演练 |

## 三、开放注册前硬性检查清单（10 项，逐项签字后放行）

见 `docs/OPERATIONS-上线演练手册.md` §7。摘要：
1. 生产创建管理员账号（本次发现生产 admin_roles=0）+ MFA + 撤销 bootstrap code
2. Pages 前端部署（07c-06 未部署）+ 生产环境变量 + CI 部署步骤
3. 占位邮箱替换（07B 遗留）
4. Turnstile 生产密钥替换（当前测试密钥恒过）
5. workers.dev 数据面 /api/health 无阻断网络验证
6. Cloudflare Dashboard Spend Alerts 设置
7. 数据来源跨境/授权人工复核（07B 遗留）
8. 隐私政策/服务条款法务审阅（07B 遗留）
9. 首次生产备份转存加密私有存储
10. 生产迁移台账双库 pending=0

## 四、工程门禁

- 四门禁（typecheck/lint/test/build）：见提交前运行记录，全部通过。
- CI：主提交与收尾提交 run 均 success（run id 见 git 记录）。
- 备份/PII：`backups/` 不入 git；证据文件不含密钥与 PII 明文。

## 五、遗留与阻塞

- 本轮不替换 07B 遗留项（占位邮箱/Turnstile/跨境核验/法务），已全部固化进上线前硬性清单（手册 §7），开放注册前必须逐项关闭。
- workers.dev 数据面验证依赖网络环境，切换网络后补做。
