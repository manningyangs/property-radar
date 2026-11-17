# TASK-09 跨源房价获取机制 · 验收报告

日期：2026-11-17 ｜ Spec：`.trae/specs/cross-source-price-collection/` ｜ 状态：**验收通过**（贝壳真实数据面遇登录墙，按负责人裁决如实报 down、机制全量交付）

## 一、任务与裁决

负责人要求：房价数据来源单一 → 补充贝壳/房天下等前沿数据源，以科研用途可达的爬虫机制获取准确房价，形成**交叉房价获取机制**。两项前置裁决（spec §0）：

1. **贝壳低频科研采集放行**：robots 全站 Disallow 的风险由裁决承担；严格边界留痕——仅公开小区挂牌页、每小区 ≤30 套、限速 ≥1s、不绕登录/验证码、不存 HTML、手工触发不入 cron。
2. **双源挂牌中位数交叉核验阈值 = 15%**：超阈值快照标 `outlier` 进后台质量异常。

执行中新事实：贝壳对匿名访客**强制登录**（实测登录墙+验证码墙，真实浏览器同判）。请示后负责人拍板：**按 spec 交付 + 如实报 down**——采集器/来源登记/交叉核验机制全部实现并测试全绿，真实触发遇墙如实报 down、零绕过、留痕。

## 二、T1 贝壳 16 小区 URL 核验表

方法：低频公开页核验（间隔 ≥1.2s，UA=property-radar-collector/0.1）。搜索页/区页/小区页/翻页/移动端全部命中登录墙；改用公开直出渠道等价取证（城市首页内嵌 `/xiaoqu/<id>/` 链接命名匹配 + robots 声明的 sitemap-ershou-resblock.xml）。

| 小区 | 区县 | xiaoqu_id | 结果 |
| --- | --- | --- | --- |
| cmt_qd_12 千禧龙花园 | 黄岛区 | 1511063904841 | ✅ 公开核验 |
| cmt_qd_14 德馨珑湖 | 即墨区 | 1517793625107522 | ✅ 公开核验 |
| 其余 14 小区（新贵都/中海银海一号/城市花园/浮山后四小区/幸福花园/鲁信长春花园/鲁信未央花园/百通馨苑/中海国际社区/卓越蔚蓝群岛/万科城市花园/福瀛天麓湖/绿城春晓苑/宏远金田花园） | — | null | 匿名渠道不可得，**如实置 null（零请求跳过），不猜测不伪造** |

登录墙截图：`evidence/09-login-wall-ershoufang.jpg`。

## 三、交付内容

| 面 | 交付 | 关键文件 |
| --- | --- | --- |
| 来源登记 | beike 条目 `approved_licensed`（裁决全文+边界 limitations）；0003 种子 public（data_sources_public/license/coverage×2/field_verifications×4 unverified/cities 双源 coverage_note）+ private（apr_beike_0001，purposes=research_validation_only） | `config/sources/data-sources.json`、`db/seeds/0003_beike_communities.{public,private}.sql` |
| 采集器 | 连接器（白名单仅 qd.ke.com、挑战页识别不绕过、≤30 套、不存 HTML）+ CLI（run_guard 门禁、批次/任务状态、--fixture 零出网、不入 cron）+ 手工构造 fixture + 18 用例 | `collectors/property_radar_collectors/beike_community.py`、`run_beike.py`、`collectors/tests/` |
| 交叉核验 | `CROSS_SOURCE_MAX_DIVERGENCE=0.15`、`METHOD_VERSION=09-aggregate-v3`；`crossSourceDivergence` 纯函数（有效源=单源 valid 单价样本≥5；≥2 有效源 (max−min)/min；**严格 >** 触发 outlier；outlier 与 low_sample 互斥；median 等仍写入留痕） | `apps/api/src/cleaning.ts`、`observations.ts` |
| 后台 | `/quality/issues` 第四类 snapshot 异常聚合（kind/查询/计数/合并）；质量页快照离群徽章/chips/行渲染/抽屉定位要素（snapshot_id/object_type/median/sample_count） | `apps/api/src/routes/admin-ops.ts`、`apps/web/src/pages/admin/quality.astro`、`apps/web/src/lib/api.ts` |
| 运维 | 贝壳低频手工采集 SOP（手册 §8）；08B-P4 遗留关闭 | `docs/OPERATIONS-上线演练手册.md` |

## 四、本地全链验收（T6）

- **种子**：0003 本地两库应用 + 幂等重跑无重复行（beike 行=1）。
- **回放**：`run_beike --fixture` 成功入库（批次=2、观测=7、拒绝=1、资格=approved_licensed、健康=ok）。
- **双源 outlier**：同日 fang+beike 构造偏差 15.1% → D1 快照实测 `quality_status=outlier、median=32765、sample_count=10、method_version=09-aggregate-v3`；14.9% 对照不触发。
- **后台可见**：`GET /admin/quality/issues?kind=snapshot` → `counts.snapshot=1`，items 含 cmt_qd_12 离群快照 + 15% 阈值说明（8 断言全过）。
- **前端渲染**：Edge 无头 + 注入已过 MFA 会话实测：徽章「◆ 快照离群 1」、表格 danger 标签、「median 32765 · 样本 10」、chip 筛选精确 1 条（5 断言全过）；截图 `evidence/09-quality-snapshot-1440.png`。
- **四门禁**：collectors pytest **118 绿**；api vitest **347 绿**（含 14.9/15.0/15.1 边界、单源、有效源<2、三源、全链 outlier、admin snapshot）；typecheck 0 错 + eslint/prettier 绿；build 20 页 + api 构建绿。

## 五、生产（T7）

- **种子**：0003 应用生产两库；幂等重跑后行数核对 `dsp=1 / lic=1 / cov=2 / fv=4 / apr=1`（无重复）。
- **部署**：Worker `6ffb07af`（含 08B-P4 缓存修复一并上线）；`/api/health` 200；P4 复验：GET 200 带 `Cache-Control: public, max-age=60, stale-while-revalidate=300`、400 不带（`evidence/09-prod-p4.txt`）。
- **真实手工触发**：`run_beike --limit 3` → 配置 16、无链接跳过 14、失败 2（`http_status_error`=挂牌页 302→clogin 登录墙），exit=1；生产留痕 `ingest_jobs.qd_beike_2026-11-17 → failed / all_communities_failed`（`evidence/09-prod-run-beike.txt`）。run_guard 资格门禁在生产通过，证明登记链路生效；**全程零绕过**。

## 六、红线复核（终检）

- ✅ 代码无任何绕过验证码/登录/风控路径（挑战页识别→如实报 down/ParseError）
- ✅ beike 未注册进 cron / daily-collect workflow（仅手工 CLI）
- ✅ fixture 为手工构造样例，仓库无真实抓取 HTML 落盘
- ✅ 链家/安居客/贝壳开放平台登记状态未被改动

## 七、遗留与后续

1. 14 个小区 `listing_url=null`：贝壳放开匿名访问（或取得授权渠道）后补核验。
2. `source_field_verifications` 4 字段初始 unverified：待首批真实解析实测回填。
3. 交叉核验机制为通用能力：beike/fang/手工录入任两源同组即生效；beike 数据面放开前，实际交叉能力由 fang+手工录入支撑。
4. 手册 §7 第 8 项（08B 修版）：P4 已关闭；sources.astro 白名单与 /account 真实化仍待 Pages 新构建部署复验。
