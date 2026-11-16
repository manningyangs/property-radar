# TASK-06D 任务清单

## Task 0 前置
- [ ] SubTask 0.1 读任务书 1368–1374 + PRD §8.1/8.2/8.6/8.7/10.4/10.5/视觉系统 + 探查现状（internal 端点、ingest_jobs/observations schema、06B overview、AdminSidebar、api.ts）
- [ ] SubTask 0.2 AskUserQuestion 拍板四项 + 备份 tag `pre-v1-p2-task-06d`

## Task 1 数据模型（R1）
- [ ] SubTask 1.1 private 0009_jobs_health_detail 迁移（ingest_jobs +7 列）+ down
- [ ] SubTask 1.2 public 0005_obs_batch 迁移（price_observations +batch_id +索引）+ down
- [ ] SubTask 1.3 本地 D1 应用迁移验证

## Task 2 internal 扩展（R2）
- [ ] SubTask 2.1 schemas.ts：job start/finish 增可选字段
- [ ] SubTask 2.2 internal.ts：start/finish 落新列
- [ ] SubTask 2.3 observations.ts：writeObservations 增 batchId 参数（canonical 不变）；internal/admin 两个调用点适配

## Task 3 admin API（R3/R4/R5）
- [ ] SubTask 3.1 新文件 routes/admin-ops.ts：GET /jobs（筛选/排序/分页/summary）
- [ ] SubTask 3.2 GET /quality/issues（三类聚合 + locator + counts）
- [ ] SubTask 3.3 admin-users.ts overview 增 ops 块（四指标）
- [ ] SubTask 3.4 app.ts 挂载 adminOpsRoutes

## Task 4 单测（R8）
- [ ] SubTask 4.1 admin-ops.test.ts：门禁矩阵 + jobs + quality + overview ops + internal 新字段
- [ ] SubTask 4.2 重跑幂等实证用例（batch duplicate / 观测行数不变 / finish 不改写）

## Task 5 前端 API 层（R6）
- [ ] SubTask 5.1 api.ts 类型与三函数

## Task 6 前端页面（R7）
- [ ] SubTask 6.1 src/lib/admin-gate.ts 共享 MFA 门禁
- [ ] SubTask 6.2 /admin 总览真实化（状态条+四指标卡+demo 分支保留）
- [ ] SubTask 6.3 /admin/jobs 页（表+抽屉+幂等说明）
- [ ] SubTask 6.4 /admin/quality 页（三类异常+定位要素抽屉）
- [ ] SubTask 6.5 AdminSidebar 链接实化

## Task 7 门禁与实测
- [ ] SubTask 7.1 四门禁全绿（typecheck/lint/test/build）
- [ ] SubTask 7.2 浏览器实测（登录 MFA→总览→jobs→quality→1440/1024 双档截图存 docs/evidence）

## Task 8 收尾
- [ ] SubTask 8.1 中文 commit + push + 盯 CI success
- [ ] SubTask 8.2 记忆更新 + 验收报告 docs/ + 勾选三件套收尾提交
