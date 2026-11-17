# TASK-08C 任务分解（tasks）

> 顺序执行；T2 可与 T1 并行（后端独立）。全部完成才进 T10 部署。

- [x] **T1 API 客户端扩展**：`apps/web/src/lib/api.ts` 新增 public 端点封装（8 个函数，见 spec 技术方案）+ `src/lib/city.ts`（pr_city 读写、active 兜底、badge 同步）；vitest 纯函数用例
- [x] **T2 后端覆盖申请端点**（R6b）：`me.ts` 新增 `POST /me/city-coverage-requests`（登录；校验城市在目录且 status=requestable/limited；写 `city_coverage_requests`；同人同城 pending 重复 → 409 `already_requested`）；miniflare 测试 3 例（成功/重复/非法城市）
- [x] **T3 城市范围接入**：AppShell 的 CityScopeBadge 客户端接 `/public/cities`；顶栏城市切换 + 跳 `/cities`；游客 localStorage、无 active 城市时全站空态
- [x] **T4 首页 `/`**（R1）：真实数据客户端渲染——今日数据状态卡（system/status）、最近更新小区、区域市场变化占位（有 region summary 才显示）；七态状态机；移除游客 `/me/events` 调用（R8，改条件调用）
- [x] **T5 区域页 `/regions` + 详情 `/region`**（R2/R3）：区县列表+搜索+summary 指标卡（口径/来源/日期/样本量）；低样本降级
- [x] **T6 小区页 `/communities` + 详情 `/community`**（R4/R5）：搜索联想、CommunityCard 列表、详情历史快照表 + TrendChart 客户端渲染 + SourceAttribution
- [x] **T7 `/cities` 新页**（R6）：目录搜索、状态徽章（active/limited/requestable）、coverage 详情展开、登录用户覆盖申请按钮（走 T2 端点）；游客点击申请→注册引导（Permission 态）
- [x] **T8 `/methodology` 新页**（R7）：来源列表（methodology/sources）+ 更新时间/覆盖（system/status）+ 口径说明静态文本
- [x] **T9 自动化测试补齐**：`apps/web` vitest（city.ts/api 封装/格式化/空态判定）+ T2 端点测试回归；R8 静态检查（游客页脚本不含 /me/ 调用——测试断言源码或运行时 fetch 拦截）
- [x] **T10 本地全链路验证**：wrangler dev + astro dev（本地已有栈）浏览器实测游客 7 路由截图；`docs/evidence/08c-01..04`
- [x] **T11 四门禁**：根目录 typecheck/lint/test/build 全绿
- [x] **T12 生产部署与实测**：`PUBLIC_API_BASE` 生产构建 + `wrangler pages deploy`；浏览器实测生产站游客链路（青岛数据可见、无 401 噪音、无演示数据）截图 → `docs/evidence/08c-05..06`
- [x] **T13 收尾**：中文 commit + push + 盯 CI success；验收报告 `docs/TASK-08C-*.md`；OPERATIONS 手册更新（Pages 回滚/发布流程补客户端渲染说明）；记忆更新；勾选三件套 + 收尾提交
