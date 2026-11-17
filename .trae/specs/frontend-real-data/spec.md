# TASK-08C 前端公共行情页接入真实 API（spec）

## 背景与问题（2026-11-17 实测取证）

- Pages 生产站 `https://property-radar-web.pages.dev/` 已上线，但浏览器实测 6 条游客路由全部 FAIL：
  行情页只显示"当前构建未接入任何房价数据源"空态、`/cities` 打开的是首页内容、游客页还会调用 `/me/events` 产生 401 噪音。
- 根因：前端行情页（首页/区域/小区/详情）**只实现了演示数据渲染**——`index.astro` 等页面注释明确
  "生产构建（无 PUBLIC_DEMO_DATA）：全部行情模块降级为 EmptyState"。全仓仅 `api.ts` 与 `watch/add.astro` 接了真实 API。
- 后端无此缺口：`/api/v1/public/*` 共 11 个只读端点已就绪且生产有真实数据（青岛 370200 active、16 小区、区县齐全，实测 200）。
- 附带缺口：PRD §2.2 路由清单中的 `/cities`、`/methodology` 页面不存在；`city_coverage_requests` 表已建但**无提交端点**。

## 目标（需求 R1–R9）

| # | 需求 | 验收口径 |
| --- | --- | --- |
| R1 | 首页 `/` 游客接真实数据 | 渲染今日数据状态（GET `/public/system/status`）、城市徽章、最近更新小区（GET `/public/communities?city_code=`）；无数据时诚实空态，不出现任何演示数字 |
| R2 | 区域页 `/regions` | GET `/public/regions?city_code=` 真实区县列表 + 搜索；点行进 R3 |
| R3 | 区域详情 `/region` | GET `/public/regions/:id/summary` 最新指标（口径/来源/数据日期/样本量全展示） |
| R4 | 小区搜索 `/communities` | GET `/public/communities?q=` 真实联想搜索；空结果=诚实空态 |
| R5 | 小区详情 `/community` | GET `/public/communities/:id` + `/:id/prices` 历史快照与趋势图、SourceAttribution、低样本降级 |
| R6 | 城市范围与 `/cities` 页 | CityScopeBadge 接 GET `/public/cities?q=&status=`；新增 `/cities` 页：目录搜索、active/limited/requestable 状态、覆盖详情（GET `/public/cities/:cityCode/coverage`）；游客选城 localStorage `pr_city` 持久化，默认取第一个 active 城市；登录用户提交覆盖申请走新增端点（R6b） |
| R6b | 覆盖申请端点（后端小增量） | `POST /api/v1/me/city-coverage-requests`（登录+Turnstile 无关；写 `city_coverage_requests`，重复提交幂等 409/200 口径见 tasks T2）；纳入现有 me 路由与测试 |
| R7 | `/methodology` 页 | GET `/public/methodology/sources` + `/public/system/status`：口径、来源、质量说明（PRD §2.2） |
| R8 | 游客零鉴权噪音 | 未登录时不得调用任何 `/me/*` 鉴权端点（消除 401 噪音）；登录链路（Turnstile/邮件）不在本任务范围，保持现状禁用 |
| R9 | 生产零演示数据 | `PUBLIC_DEMO_DATA` 门保持；本任务后生产构建游客全链路可见真实青岛数据（浏览器实测 + 截图证据） |

## 技术方案

- **渲染模式**：沿用既有客户端渲染惯例（`events.astro`/`watch/index.astro`/admin 页：静态骨架 + `<script>` fetch + 模板字符串 innerHTML），不引入前端框架。
- **API 层**：扩展 `src/lib/api.ts`：新增 public 数据获取封装（`getPublicCities/getPublicRegions/getRegionSummary/getPublicCommunities/getCommunity/getCommunityPrices/getMethodologySources/getSystemStatus`），复用 `PUBLIC_API_BASE` 与错误类型。
- **状态机**（PRD §2.2A 全页七态）：Loading 骨架 → Data / Empty（解释+下一步）/ Error（重试按钮）/ Stale（延迟标记）/ Low sample（降强调）；禁止假数据。
- **视觉**：复用现有 CSS 类与组件标记（PriceMetricCard/DataFreshnessBadge/CommunityCard 等的 DOM 结构在客户端模板中复刻），保持设计令牌不变；390/360/375/430/1440 视口不横向溢出。
- **城市范围**：新增 `src/lib/city.ts`（读取/设置 `pr_city`、active 城市兜底、订阅式更新 CityScopeBadge）。
- **测试**：vitest 新增 `apps/web` 侧纯函数测试（city 选择逻辑、数据格式化、空态判定）；API 端点 R6b 走 `apps/api` 现有 miniflare 测试模式。
- **部署**：本地 `PUBLIC_API_BASE` 生产构建 + `wrangler pages deploy`；CI `deploy-web.yml` 不变（token 配好后自动接管）。

## 非目标（明确不做）

- `/compare` 比较页（独立后续任务）；登录/注册链路解锁（等 Turnstile + Apps Script 手动配置）。
- 后端行情 API 不改动（仅新增 R6b 一个写端点）。
- 自定义域名/国内可达性优化（workers.dev 在大陆网络风险另案处理）。

## 完成定义（DoD）

1. 四门禁全绿（typecheck/lint/test/build）。
2. R1–R7、R8 逐条有自动化或浏览器实测证据（`docs/evidence/08c-01..06`，含生产 Pages 游客链路截图）。
3. `/cities`、`/methodology` 路由真实可访问；游客全链路无 401 噪音、无演示数据。
4. 中文 commit + push + CI success；验收报告 + OPERATIONS 手册 §7 相应更新 + 记忆 + 勾选三件套。
