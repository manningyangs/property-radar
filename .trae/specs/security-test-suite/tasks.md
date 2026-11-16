# TASK-07A 任务清单

## Task 0 前置
- [x] SubTask 0.1 读任务书 1376–1395 + PRD §7.4/7.6/14.3 + 探查现有实现与测试基线
- [x] SubTask 0.2 AskUserQuestion 拍板三项 + 备份 tag `pre-v1-p2-task-07a`

## Task 1 专项套件（R1）
- [x] SubTask 1.1 security.test.ts 骨架：env 哨兵密钥 + fetch 全捕获 stub + 双用户种子
- [x] SubTask 1.2 IDOR / 管理员越权 / session fixation 用例
- [x] SubTask 1.3 XSS / SQLi / SSRF 用例
- [x] SubTask 1.4 OTP 爆破 / 邮箱枚举 / CSRF cookie 属性用例
- [x] SubTask 1.5 CORS / Secrets 泄露 / 错误日志泄露用例

## Task 2 Secrets 门禁（R2）
- [x] SubTask 2.1 scripts/check-secrets.mjs + 本地全仓扫描
- [x] SubTask 2.2 ci.yml 增 secrets-scan job

## Task 3 修复（R3，如有发现）
- [x] SubTask 3.1 修复 + 回归断言

## Task 4 门禁与证据
- [x] SubTask 4.1 四门禁全绿
- [x] SubTask 4.2 运行输出存 docs/evidence/07a-*

## Task 5 收尾
- [x] SubTask 5.1 中文 commit + push + 盯 CI success
- [x] SubTask 5.2 验收报告 + 记忆更新 + 勾选三件套 + 收尾提交
