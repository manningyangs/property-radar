# TASK-07B 任务清单

- [x] T1 Migration：`db/migrations/private/0016_account_deletion.up.sql`（+down）；`packages/migrations/src/index.test.ts` 断言新列
- [x] T2 API 注销：me.ts `/me/delete-account` 实现（confirm 校验、管理员守卫、幂等、吊销全部会话、清 cookie）
- [x] T3 API 冷静期撤销：auth.ts verify-code 允许 deletion_pending 登录并复位
- [x] T4 API 导出：me.ts `/me/export` 聚合 JSON + Content-Disposition
- [x] T5 到期硬删：`apps/api/src/deletion.ts` purgeExpiredDeletions + index.ts cron 接线
- [x] T6 测试：`apps/api/src/data-compliance.test.ts` 四组用例（export/delete/撤销/purge）
- [x] T7 Web 页面：`privacy.astro`、`terms.astro` 全文
- [x] T8 Web 接线：api.ts 两方法；account.astro 导出/注销/政策链接替换 stub
- [x] T9 四门禁：typecheck / lint / test / build 全绿
- [x] T10 实测证据：docs/evidence/07b-01..05（本地栈真实流程 + 截图；07b-05 以 PUBLIC_DEMO_DATA=1 临时 dev 重截 4 页来源展示）
- [x] T11 提交：中文 commit + push + 盯 CI success（01b5bcc / run 43819553896）
- [x] T12 收尾：验收报告 docs/TASK-07B-数据合规检查验收报告.md + 记忆更新 + 勾选三件套 + 收尾提交盯 CI
