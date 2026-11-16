# TASK-07C 验收 Checklist

## A. 演练项（任务书 1388–1393 逐条）

- [x] A1 数据库备份和恢复：备份脚本生产真实导出双库（manifest+SHA256）；恢复演练 TEMP 导入 PASS（integrity_check+行数+抽样）；生产恢复 runbook 成文
- [x] A2 采集失败时的降级：本地实测 job failed+health down+系统事件+/admin/jobs 可见；run_guard 未授权零采集
- [x] A3 邮件达到免费额度时降级：达 80/24h 帽→quota_deferred/quota_blocked、站内事件保留、OTP 独立预留帽不受影响
- [x] A4 Source 被投诉/授权撤销时一键停用：suspend→eligibility 阻断→回放零新观测；审批历史 append-only 保留
- [x] A5 回滚前端、Worker、D1 migrations：Worker 生产真实回滚演练并切回（二次健康验证）；D1 down 链测试证据引用+runbook；前端 Pages 回滚路径核实成文（或列入阻塞项）
- [x] A6 检查免费额度和费用保护：固定负载统计表、Cloudflare/Apps Script 配额对照表、dashboard spend alerts 手动项清单

## B. 上线门槛核对（任务书 1395）

- [x] B1 核心数据真实、合法授权、来源可追溯（引 00B/04C/07B 复核）
- [x] B2 用户隔离和管理员权限测试通过（引 07A security.test.ts）
- [x] B3 没有未授权平台爬虫（allowlist+source-gate，引 07B）
- [x] B4 没有明文密钥进入仓库（secrets-scan CI，引 07A）
- [x] B5 价格口径没有混淆（双口径+规则绑定矩阵，引 03B/04E）
- [x] B6 开放注册前硬性检查清单成文（占位邮箱、Turnstile 生产密钥、跨境核验、Pages 部署、dashboard 费用提醒、法务审阅）

## C. 工程门禁

- [x] C1 四门禁全绿（typecheck/lint/test/build），新脚本过 eslint/prettier
- [x] C2 备份产物与导出日志不入 git（.gitignore backups/ 生效，git status 干净）
- [x] C3 中文 commit + push + CI success（主提交与收尾提交均绿）
- [x] C4 演练失败项如实记录（修复或转阻塞清单），无假绿
