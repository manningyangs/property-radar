# TASK-07C 任务清单

- [x] T1 备份 tag + 三件套（spec/tasks/checklist）并获批
- [x] T2 scripts/db-backup.mjs（remote 双库导出 + manifest + .gitignore backups/）
- [x] T3 scripts/db-restore-drill.mjs（TEMP 导入 + integrity_check + 行数/抽样对生产）→ 证据 07c-01
- [x] T4 本地 e2e：采集失败降级链路实测 → 证据 07c-02
- [x] T5 本地 e2e：邮件额度达限降级实测 → 证据 07c-03
- [x] T6 本地 e2e：一键停用全链路（suspend→run_guard→零采集）实测 → 证据 07c-04
- [x] T7 生产 Worker 版本回滚真实演练（基线→回滚→验证→切回→验证）→ 证据 07c-05
- [x] T8 前端 Pages 部署核实 + 回滚路径成文/补演练 → 证据 07c-06
- [x] T9 免费额度与费用保护核对表（负载统计 + 配额对照 + dashboard 手动项）
- [x] T10 docs/OPERATIONS-上线演练手册.md（六项 runbook）
- [x] T11 四门禁全绿（typecheck/lint/test/build）
- [x] T12 中文 commit + push + 盯 CI success
- [x] T13 验收报告（上线门槛核对表 + 开放注册前硬性检查清单）+ 记忆 + 勾选三件套 + 收尾提交盯 CI
