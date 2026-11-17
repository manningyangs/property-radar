# TASK-09 spec：跨源房价获取机制（贝壳采集器 + 双源交叉核验）

## §0 负责人裁决与边界（2026-11-17，本 spec 的授权真源）

1. **贝壳低频科研采集放行**：`qd.ke.com` robots.txt 尾部 `User-agent: * / Disallow: /`（全站禁）+ 平台服务协议禁未经授权的自动化采集。负责人基于科研调查用途裁决放行，同 04D fang_com 先例（负责人 2026-11-12 裁决），严格边界全部静态/结构化强制：
   - 仅公开小区挂牌列表页（`qd.ke.com/ershoufang/c<xiaoqu_id>/`），每小区仅首页、≤30 套样本；
   - 限速 ≥1s/请求（SafeHttpClient 默认，不放宽）；
   - 不绕过登录/验证码/风控挑战页——识别即如实报 down / 抛 ParseError，绝不伪造解析；
   - 不存原始 HTML（生产数据只留业务字段；测试 fixture 为手工构造样例，不落真实抓取页面）；
   - **不入 cron / 不入 daily-collect workflow**，仅手工触发（本地 CLI 或 workflow_dispatch）；
   - 贝壳与链家同平台同数据 → 只登记一个源 `beike`（qd.ke.com 域），不重复登记链家，避免双域虚增样本。
2. **双源挂牌中位数交叉核验阈值 = 15%**：同一（小区, 价格类型, 指标, 统计日）组内，≥2 个"有效源"（单源 valid 单价样本 ≥ MIN_VALID_SAMPLES=5）且各源中位数最大相对偏差 > 0.15 → 快照标 `quality_status='outlier'`（仍计算留痕、不隐藏），进后台质量异常；≤0.15 不触发。

## §1 侦察事实（2026-11-17 实测，写入依据）

- `https://qd.ke.com/ershoufang/` HTTP 200 / 218KB，服务端直出 30 组 priceInfo/totalPrice 房源数据，无验证码墙；页面含 ljcdn risk-control JS 但不拦截。
- `qd.ke.com/robots.txt` 与 `qd.lianjia.com/robots.txt` 同构全站 Disallow。
- 小区挂牌列表 URL 形态：`https://qd.ke.com/ershoufang/c<xiaoqu_id>/`。
- **2026-11-17 追加实测（负责人确认"按 spec 交付+如实报 down"）**：贝壳对匿名访客强制登录——`/xiaoqu/`、`/xiaoqu/rs<名>/`、`/ershoufang/<区>/`、`/ershoufang/c<id>/`、`/ershoufang/pg2/`、`m.ke.com` 全部 302 至 clogin 登录墙或 hip captcha 墙（真实浏览器同样被拦，截图证据）；仅城市首页 `/ershoufang/` 直出 200（含 30 组房源与 `/xiaoqu/<id>/` 链接）与 `robots.txt` 声明的 `sitemap-ershou-resblock.xml`（7616 个 `/xiaoqu/<id>` URL，无名称）公开。链家同平台同墙（区页登录墙实测一致）；安居客小区页验证码墙。
- **结论**：小区 URL 核验改为公开渠道等价取证（城市首页直出链接 + 站点声明的 sitemap），配置按"公开页可核验"如实标注；采集器真实运行遇登录墙**如实报 down/ParseError，零绕过**（红线），贝壳一旦放开匿名访问即自动生效。交叉核验机制为通用能力：beike/fang/手工录入任两源同组即生效。

## §2 需求分解

### R1 贝壳小区挂牌采集器（Python，与 fang_community 同构）

新增/修改文件：

- `collectors/property_radar_collectors/beike_community.py`（新）
  - `SOURCE_ID = "beike"`、`CITY_CODE = "370200"`、`OBJECT_LEVEL = "community"`、`CONNECTOR_VERSION = "beike_community/0.1.0"`、`MAX_LISTINGS_PER_COMMUNITY = 30`；
  - `BeikeCommunityConnector(SourceConnector)`：`allowed_hosts = ("qd.ke.com",)`（静态白名单，fail closed）、`allowed_insecure_hosts = ()`、`supports_community = True`；
  - 挑战页识别 `_CHALLENGE_MARKERS`：命中 `verify.ke.com`、`人机验证`、`captcha`、`verify/code` 任一特征 → `is_challenge_page()` True；health_check 返回 down（detail 说明"识别但不绕过"），fetch 抛 `ParseError`；3xx 重定向由 SafeHttpClient 不跟随，天然失败降级；
  - 解析 `parse_listing_cards(html)`：按 `<li ... class="clear"...>` 房源卡片切块，先 `_TAG_RE` 去标签再抽取——总价 `([\d.]+)\s*万`（`.totalPrice` 文本）、单价 `([\d,.]+)\s*元/㎡`、面积 `([\d.]+)\s*平米`（houseInfo 段 `|` 分隔第 2 项）；至少含总价或单价之一，否则跳过（广告/推荐位）；上限 30 套；产物只留 `total_price_yuan / unit_price_yuan_sqm / area_sqm` 业务字段；
  - `load_communities(config_path)` 读 `config/cities/qingdao-community-listings-beike.json`；
  - `health_check()` GET 配置首个挂牌页（同 fang：挑战页→down、短响应→degraded、正常→ok）；
  - `fetch_region_data()` 返回空（不做城市级）；`_fetch_community_data()` / `fetch_community_listings()` 与 fang 同语义：无 URL 零请求跳过、未知 community_id 抛 ParseError、每套一条 SourceRecord（sample_count=1，stat_date=run_date）。
- `collectors/property_radar_collectors/run_beike.py`（新）：run_communities.py 同构 CLI——`run_guard(client, "beike", "370200", "community")` 资格门禁 → health_check + report_health → `job_start(qd_beike_<run-date>)` → 逐小区 fetch → normalize(price_type="listing_ask", metric_code="listing_ask_unit") → `submit_batch(batch_id=qd_beike_<run-date>_<cid>, source_id="beike", observations[])` → job_finish；`--fixture tests/fixtures/beike` 离线回放（MockTransport：`/`→beike_home.html，`/ershoufang/c<id>/`→`<id>.html`，缺失 404）；`--limit` 抽样；全失败判 failed；不入 cron。
- `config/cities/qingdao-community-listings-beike.json`（新）：meta（purpose/source_id/city_code/url_pattern/id_derivation/boundaries 裁决文本/created_at）+ 16 个 `cmt_qd_01..16` 条目（community_id / name / district / xiaoqu_id / listing_url；核验不到的小区 url 置 null，零请求跳过）。
- `collectors/tests/fixtures/beike/`（新）：**手工构造**的代表性列表页 HTML（beike_home.html + 若干 `<xiaoqu_id>.html`，含正常卡片、广告位、缺单价卡片、>30 套、挑战页样本），不保存真实抓取页面。
- `collectors/tests/test_beike_community.py`（新）：解析纯函数用例（总价/单价/面积抽取、广告跳过、≤30 上限）、挑战页识别（health down + fetch ParseError，不绕过）、白名单仅 qd.ke.com（其他域拒绝）、未知 community_id 抛错、run_beike fixture 离线回放（api_transport MockTransport：断言 run_guard 门禁、批次数、观测数、幂等重放同 observation 键、全失败判 failed）。

### R2 来源登记更新

- `config/sources/data-sources.json`：新增 `beike` 条目——`status="approved_licensed"`、`allowed_automatic=true`（仅手工触发级自动，frequency 注明"低频验证（手工触发，不入定时任务）"）、object_levels `["community","listing"]`、metrics `["community_ask_median_unit","listing_ask_unit"]`、price_type listing、license_basis=负责人 2026-11-17 裁决全文（robots 全站 Disallow 风险由裁决承担并留痕、科研用途、严格边界清单）、limitations=执行边界（16 小区首页/≤30 套/≥1s/不绕验证/不存 HTML/不入 cron）、verified_at 2026-11-17、notes 指向本 spec §0 与验收报告；既有 `beike_open_platform`（商务开放平台，pending_review）与 `lianjia`（manual_only）条目保留不动，notes 补一句"公开挂牌页采集由 beike 条目承载（同平台不重复登记）"。
- `db/seeds/0003_beike_communities.public.sql`（新，幂等 ON CONFLICT，模式同 0002）：
  1. `data_sources_public` beike 行（name 贝壳找房、source_type portal_listing、official_url https://qd.ke.com/、data_scope 青岛 16 小区公开挂牌首页样本、license_note_url https://qd.ke.com/robots.txt、display_scope 同 fang 口径）；
  2. `source_license_state` beike → approved_licensed；
  3. `source_city_coverage` beike×370200×community/listing 两行（metrics 同 fang，authorization_status approved_licensed，last_verified_at 2026-11-17）；
  4. `source_field_verifications` beike 四字段（total/unit/area/count 初始 unverified，首批真实解析后回填 verified）；
  5. `cities` coverage_note 更新为双源表述（房天下+贝壳两源挂牌样本与交叉核验）。
- `db/seeds/0003_beike_communities.private.sql`（新）：`source_approvals` `apr_beike_0001`（action approve、approver u_system_ops、evidence_ref 本 spec §0-1 负责人 2026-11-17 裁决、permitted_fields 四字段、purposes `["research_validation_only"]`、cities `["370200"]`、frequency `on_demand_validation_only`、retention `raw_html_never_stored_90d_observations`、status_after approved_licensed、note 严格边界全文）。
- 应用：本地两库 + 生产两库 D1 各执行 0003 public/private（wrangler d1 execute，命令记入 OPERATIONS）。

### R3 双源交叉核验（服务端）

- `apps/api/src/cleaning.ts`：
  - 新增导出 `CROSS_SOURCE_MAX_DIVERGENCE = 0.15`（含注释：负责人 2026-11-17 裁决阈值）；
  - `METHOD_VERSION` 升为 `"09-aggregate-v3"`，注释追加 v3 口径说明（跨源中位数核验）。
- `apps/api/src/observations.ts` `writeObservations` 快照重算段：
  - 组内 SELECT 增加 `source_id` 列；
  - 新增纯函数 `crossSourceDivergence(rows)`：按 source_id 分组（仅 valid 且单价非空），各组 computeStats 取 median；"有效源"= 组内样本 ≥ MIN_VALID_SAMPLES 的源；有效源 ≥2 时返回 `(max_median − min_median) / min_median`，否则返回 null；
  - 快照 quality 判定改为：`divergence != null && divergence > CROSS_SOURCE_MAX_DIVERGENCE` → `"outlier"`；否则维持原 low_sample/valid 逻辑（outlier 与 low_sample 天然互斥：触发 outlier 需 ≥2×5=10 样本）；median/mean/p25/p75 照常全量写入（留痕不隐藏）；
  - 模块头注释补 R3 口径。
- `apps/api/src/routes/admin-ops.ts` `/quality/issues`：
  - `QualityIssue.issue_kind` 联合类型增 `"snapshot"`；`ISSUE_KINDS` 增该值；
  - 新增第 4 路查询：`price_snapshots WHERE quality_status='outlier'`（可选 source_id 过滤按快照行 source_id），locator 含 snapshot_id/object_id/price_type/metric_code/stat_date/median/sample_count，note 写"双源中位数相对偏差超过 15% 阈值（TASK-09 R3）"；并入合并按时间倒序分页；计数查询同步。
- 后台前端质量页（`apps/web` admin quality issues 组件）：为 issue_kind="snapshot" 增加中文标签渲染（"快照离群"），复用现有列表样式；实施时先读该组件确认渲染分支，最小改动。
- 公开端点不改结构（`/public` 快照响应已透出 quality_status，outlier 原样可见）；rules-engine 不改（outlier 天然不触发订阅规则——既有 BAD 过滤）。
- 测试：`apps/api/src/observations.test.ts`（或既有测试文件扩展）新增用例——
  - 偏差 14.9%（阈值内）→ valid；15.1% → outlier；恰好 15.0% → 不触发（> 严格）；
  - 单源 20 样本 → 不触发；双源但一源 4 样本（有效源<2）→ 不触发；
  - outlier 快照 median/p25/p75 仍写入；
  - `cleaning.test.ts` 常量与 METHOD_VERSION 断言更新。

### R4 文档与验收

- `docs/OPERATIONS.md`：新增"TASK-09 贝壳手工触发 SOP"——本地/生产 API_BASE 与密钥注入、`python -m property_radar_collectors.run_beike [--limit N|--fixture ...]`、与 fang 同日运行建议（交叉核验仅同 stat_date 组生效）、0003 种子应用命令、明确"不入 cron"红线。
- `docs/TASK-09-跨源房价获取验收报告.md`：16 小区贝壳 URL 核验记录表（搜索页 → xiaoqu_id → 命名匹配判据）、首批真实采集实测（health/批次数/观测数）、交叉核验触发证据（本地库构造或真实双源同日数据）、四门禁结果、裁决边界复核清单。
- 记忆更新 + 三件套勾选 + commit/push/CI 盯梢（既有纪律）。

## §3 验收标准（checklist 对应）

1. collectors pytest 全绿（含新增 beike 用例，零出网）；
2. api 单测全绿（含跨源边界 14.9/15.0/15.1、单源、样本不足用例）；typecheck/lint/build 门禁全绿；
3. 本地 e2e：0003 种子应用 → run_beike --fixture 回放成功入库 → 同日 fang+beike 构造偏差>15% → 快照 outlier → admin /quality/issues 可见 snapshot 类异常 → 前端质量页渲染；
4. 生产：0003 种子应用 + Worker 部署（含 08B 修版遗留一并部署复验）+ 手工真实触发 run_beike（--limit 抽样）成功或如实 down（遇风控墙不绕过）；
5. 边界复核：代码/配置中无绕过验证码路径、无 cron/workflow 注册 beike、白名单仅 qd.ke.com、fixture 为手工构造非真实抓取页。

## §4 非目标

- 不做链家/安居客/贝壳开放平台自动采集；不做城市级贝壳汇总；不做历史数据回填；不改前端小区卡多源徽章展示（快照 source_id 维持"最后写入者"既有口径）；不新增数据库列/迁移。
