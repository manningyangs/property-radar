# TASK-07B 任务清单

- [x] T1 Migration：`db/migrations/private/0016_account_deletion.up.sql`（+down）；`packages/migrations/src/index.test.ts` 断言新列
- [ ] T2 API 注销：me.ts `/me/delete-account` 实现（confirm 校验、管理员守卫、幂等、吊销全部会话、清 cookie）
- [ ] T3 API 冷静期撤销：auth.ts verify-code 允许 deletion_pending 登录并复位
- [ ] T4 API 导出：me.ts `/me/export` 聚合 JSON + Content-Disposition
- [ ] T5 到期硬删：`apps/api/src/deletion.ts` purgeExpiredDeletions + index.ts cron 接线
- [ ] T6 测试：`apps/api/src/data-compliance.test.ts` 四组用例（export/delete/撤销/purge）
- [ ] T7 Web 页面：`privacy.astro`、`terms.astro` 全文
- [ ] T8 Web 接线：api.ts 两方法；account.astro 导出/注销/政策链接替换 stub
- [ ] T9 四门禁：typecheck / lint / test / build 全绿
- [ ] T10 实测证据：docs/evidence/07b-01..05（本地栈真实流程 + 截图）
- [ ] T11 提交：中文 commit + push + 盯 CI success
- [ ] T12 收尾：验收报告 + 记忆更新 + 勾选三件套 + 收尾提交盯 CI
