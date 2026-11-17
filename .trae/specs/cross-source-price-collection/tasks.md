# TASK-09 tasks：跨源房价获取机制

> 顺序执行；每项完成后在 checklist.md 勾选。T1 与 T2 可并行。

## T1 [x] 贝壳 16 小区 URL 核验（低频、留痕）
- 逐小区低频 curl `https://qd.ke.com/xiaoqu/rs<小区名>/` 搜索页（间隔 ≥1s、UA 同采集器），解析首个 `/xiaoqu/<id>/` 链接并核对小区名匹配；
- 命中→记录 xiaoqu_id 与 `https://qd.ke.com/ershoufang/c<id>/`；未命中/存疑→listing_url=null；
- 结果写入 `config/cities/qingdao-community-listings-beike.json`（meta 注明核验日期与方法）+ 验收报告核验表。

## T2 [x] spec §1 侦察结论固化
- 无代码改动；侦察事实已写入 spec §1（完成即勾）。

## T3 [x] 来源登记（R2）
- `config/sources/data-sources.json` 新增 `beike` 条目（approved_licensed，负责人 2026-11-17 裁决留痕+严格边界全文）；beike_open_platform/lianjia notes 补指向说明；
- 新建 `db/seeds/0003_beike_communities.public.sql` + `.private.sql`（幂等，模式同 0002，内容按 spec R2 五条/一条）。

## T4 [x] 贝壳采集器（R1）
- `collectors/property_radar_collectors/beike_community.py`（连接器+挑战页识别+解析纯函数+配置加载）；
- `collectors/property_radar_collectors/run_beike.py`（CLI，run_communities 同构，不入 cron）；
- `config/cities/qingdao-community-listings-beike.json`（T1 产物）；
- `collectors/tests/fixtures/beike/` 手工构造 HTML + `collectors/tests/test_beike_community.py`；
- 验证：`python -m pytest tests/test_beike_community.py`（cwd=collectors）全绿、零出网。

## T5 [x] 交叉核验机制（R3）
- `apps/api/src/cleaning.ts`：`CROSS_SOURCE_MAX_DIVERGENCE=0.15` + `METHOD_VERSION="09-aggregate-v3"`；
- `apps/api/src/observations.ts`：SELECT 加 source_id、`crossSourceDivergence` 纯函数、outlier 判定接入 quality 分支；
- `apps/api/src/routes/admin-ops.ts`：/quality/issues 增 snapshot 类异常（kind 枚举+查询+计数+合并）;
- 后台前端质量页组件：issue_kind="snapshot" 中文标签渲染（先读组件再最小改）；
- 单测：observations 边界 14.9/15.0/15.1、单源、有效源<2、outlier 仍写 median；cleaning 常量断言。

## T6 [x] 本地全链验收
- 本地 API 起服 → 应用 0003 种子（public+private）→ `run_beike --fixture` 回放成功；
- 同日构造 fang+beike 偏差>15% 数据 → 快照 outlier → admin /quality/issues 见 snapshot 异常 → 前端渲染；
- 四门禁：collectors pytest / api vitest / typecheck+lint / build 全绿。

## T7 [x] 生产部署与真实触发
- 生产两库应用 0003 种子；Worker 部署（含 08B 修版遗留一并）+ 可达复验；
- 手工真实触发 `run_beike --limit 3`（成功入库或遇风控如实 down——均记录进验收报告，不绕过）。

## T8 [x] 收尾
- `docs/OPERATIONS.md` 贝壳手工 SOP 章节；
- `docs/TASK-09-跨源房价获取验收报告.md`（核验表/实测/证据/边界复核）;
- 记忆更新、三件套勾选、中文 commit/push、盯 CI 全绿。
