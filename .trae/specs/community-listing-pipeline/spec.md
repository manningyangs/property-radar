# SPEC: TASK-04D 小区级数据接入（青岛 16 小区真实挂牌验证管线）

> PRD 任务书 V1.2 · 任务行 1304–1310 · 关联 §5.4 三方平台与用户提供链接 / §5.6 连接器规范 / §9.1 price_observations+price_snapshots / §10.4 导入 API / §4.4 小区挂牌统计

## 0. 用户已拍板的三项范围决策（含红线更正）

1. **数据源**：**对公开挂牌页做轻量爬取获取真实数据，仅做验证用**。用户（负责人）于 2026-11-12 明确裁决：任务行 1308"不实现贝壳/链家/安居客自动爬虫"的红线**写错了，按用户指令执行**。本任务据此获得授权依据（§12.0-10），但执行上仍守以下边界：
   - 只抓公开列表页 HTML，**不绕过验证码/登录/访问控制**（§12.0-6 不变），不存原始 HTML（§5.7）；
   - 目标平台以**房天下（fang.com）青岛小区出售列表页**为首选（00B 核验清单已含多个该平台链接）；不碰贝壳（商务授权制）；
   - 低频、限速、每小区只取列表首页样本；不入定时任务（仅验证用途，手工/一次性运行）。
2. **管线形态**：**internal API（爬虫提交）+ admin API（手工补录）+ seed**，不做用户端录入 UI（留后续阶段）。
3. **落库口径**：**观测（price_observations）与快照（price_snapshots）都写**——批次携带观测数组落明细，服务端按（对象,价格类型,指标,统计日）聚合成快照；与 04E 职责边界见 §2 R7。

## 1. 背景与现状（调研结论）

- 00B 已完成 **16 个青岛小区目录层核验**（[config/cities/qingdao-community-verification.json](../../../config/cities/qingdao-community-verification.json)，9 区、同名消歧、来源链接），价格层当时标记 `blocked_on_source_authorization`——本任务的爬取授权即解阻塞。
- D1 现状：`price_observations`/`price_snapshots` 表已就绪（02A）；**`regions`/`communities` 无任何种子数据**（本地与远端均 0 行），`GET /public/communities*` 端点已存在但查无数据。
- `ingest/batch` 只收 `observed_count` 不落明细（04A 设计如此，"清洗/去重落库属 04E"）——本任务按拍板决策扩展（见 R2，04E 只留清洗规则）。
- `user_manual_record` 源已登记 `approved_open`（PRD §5.4 人工路径）；`fang_com` 源登记 `manual_only`（robots Disallow 挂牌列表页）——本任务依负责人授权将其升为可自动采集（见 R4）。
- `NormalizedObservation`（04B/04C）已支持 price 口径全字段与极端价格护栏；`SafeHttpClient` allowlist 已含 http 白名单例外机制。
- 前端：`communities.astro` 列表页与 `community.astro` 详情页已就绪（详情页读快照 median/mean/p25/p75/sample_count/quality_status，"样本少于 5 套不发布代表性价格"）；`GET /public/communities/:id/prices` 现不返回 `collected_at`（验收需要，见 R3）。
- 登记册 `user_manual_record.price_type="manual_verified"` 与 DB CHECK 枚举不一致——**本任务拍板映射为 `user_reported`**（DB 枚举为唯一真源，登记册笔误随 R4 一并校正）。

## 2. 需求（In Scope）

### R1 小区目录种子（先有对象，再有数据）

- **`db/seeds/0002_qingdao_communities.public.sql`**（幂等，本地与远端同一文件）：
  - `regions`：青岛市 9 个取样区（市南/市北/崂山/李沧/城阳/黄岛/即墨/胶州/莱西，level=district，parent_id NULL，source_id 可空）；`ux_regions_city_parent_name_level` 冲突走 ON CONFLICT DO NOTHING。
  - `communities`：00B 清单 16 小区（community_id 用确定性 ID `cmt_qd_<两位序号>` 与清单顺序一致；city_code=370200、region_id 关联、name/alias_json/built_year 按 JSON、address_coarse 取 block 中门牌、identity_source=`task-00b-verification`、status=`active`）。
  - 重复执行幂等；不导入全国全量小区（PRD 00B 红线）。
- **`config/cities/qingdao-community-listings.json`**（新配置，不入密钥）：16 小区 → 房天下列表页 URL（00B JSON 已有的直接复用；缺链接的小区实施期按名称在房天下检索补一条，仍缺则标 `listing_url: null` 并计入未覆盖结论）。

### R2 internal 批次扩展：观测数组落库 + 快照聚合（爬虫提交路径）

- **`ingestBatchSchema` 增 `observations` 可选数组**（`additionalProperties:false` 保持；`observed_count` 保留且当 observations 存在时必须与其长度一致，否则 400）：
  - 每项：`object_id`(≤128)、`property_type`(enum)、`price_type`(enum)、`metric_code`(≤64)、`price_total_fen`(int≥0 可空)、`unit_price_yuan_sqm`(int≥0 可空)、`area_sqm`(>0 可空)、`sample_count`(int≥0)、`stat_date`(YYYY-MM-DD)、`quality_status`(enum)、`connector_version`(≤32)；总价与单价至少一项非空（与 Python normalize 同口径）；数组 `maxItems: 500`。
- **服务端落库（`apps/api/src/observations.ts` 新模块，internal 与 admin 复用）**：
  - `payload_hash` = SHA-256(观测字段规范化 JSON)；`observation_id` = SHA-256(`source_id|object_type|object_id|price_type|metric_code|stat_date|payload_hash`) 前 32 hex——**确定性 ID + `INSERT … ON CONFLICT(observation_id) DO UPDATE`**，同观测重复提交幂等不重复行。
  - 落库后对每个受影响组 `(object_type, object_id, price_type='listing_ask', snapshot metric, stat_date)` **全量重算聚合**（读该组全部 `quality_status='valid'` 且 `unit_price_yuan_sqm IS NOT NULL` 的观测）：median / mean / p25 / p75（**线性插值，numpy 默认口径**，实现写在单一纯函数 `computeStats()` 供测试直测）、`sample_count` = 有效观测数、`collected_at=datetime('now')`、`source_id`；`ON CONFLICT` 走既有 `ux_price_snapshots_key` upsert。
  - 快照 `quality_status`：`sample_count >= 5 ? 'valid' : 'low_sample'`（PRD §4.4 小样本降级；median 等仍计算保存留痕，不静默删除）。观测行 `quality_status` 由提交方给（爬虫路径一律 `valid`，极端值在 Python normalize 已拒绝）。
  - **metric 映射固定代码常量**：观测 `metric_code=listing_ask_unit`（逐套样本单价）→ 快照 `metric_code=community_ask_median_unit`（PRD §4.2 小区指标）；object_type 一律 `community`（无独立 listing 实体，样本挂在小区对象下，与既有数据模型一致）。
- **`POST /internal/ingest/batch`** 行为：原门禁/签名/幂等确认（duplicate batch_id → 202 duplicate 不重写）全部不变；批内带 observations 时走 R2 落库，响应附 `observations_written`、`snapshots_upserted`。
- **`POST /admin/observations`（手工补录路径）**：admin 会话+角色门禁；body 即单条观测（同 R2 字段）+ `source_id`；写 price_observations + 重算该组快照（复用同一模块）；用于 `user_reported`（price_type 限 `user_reported`/`listing_ask`）手工核验记录，每条写 `audit_logs`。

### R3 公开 API 补齐验收字段

- `GET /public/communities/:id/prices` SELECT 增 `collected_at`——验收"逐小区给出 source、price_type、sample_count、stat_date、collected_at、quality_status"由该端点直接可复查（`source_id` 已在返回中）。
- 新增 **`GET /public/communities/coverage?city_code=370200`**：逐小区返回 `{community_id, name, district, snapshot: {source_id, price_type, metric_code, sample_count, stat_date, collected_at, quality_status} | null}`——即"每个小区的覆盖结论可复查"的机器可查形态；无快照的小区 `snapshot: null`（如实显示未覆盖，不造数）。

### R4 数据源授权状态更新（依据 §0-1 负责人裁决）

- `config/sources/data-sources.json` `fang_com`：`status: manual_only → approved_licensed`；`allowed_automatic: true`；`object_levels: ["community","listing"]`；`metrics: ["community_ask_median_unit","listing_ask_unit"]`；`license_basis` 注明"负责人 2026-11-12 裁决：任务书 04D 禁爬红线更正为允许（仅验证用途、公开列表页、不绕过访问控制）"；`limitations` 注明限速/不存 HTML/不入定时任务；`verified_at` 更新。
- `user_manual_record.price_type: "manual_verified → user_reported"`（枚举笔误校正，§1 结论）。
- 种子同步（R1 文件内一并写，与 0001 种子同模式）：`source_license_state`（fang_com=approved_licensed，valid_until=null）、`source_city_coverage`（fang_com × 370200 × community/listing 两行、metric_codes 按上、authorization_status=approved_licensed）、`source_approvals`（§5.3 字段：evidence_ref=负责人裁决记录于本 spec 与 docs 报告、permitted_fields=挂牌总价/单价/面积/样本、purposes=验证管线、frequency=低频验证、retention=90 天说明、approver=u_system_ops 引导审批人）、`source_field_verifications`（挂牌页实测字段：`listing_total_price`/`listing_unit_price`/`listing_area`/`listing_count`=verified——首批真实解析成功后填 evidence，`listing_deal_date`/`listing_listed_date`=unverified 页面未取到则不进 verified_metrics）。

### R5 青岛小区挂牌爬虫连接器与运行 CLI（Python）

- **`collectors/property_radar_collectors/fang_community.py`**：
  - `FangCommunityConnector(SourceConnector)`：`source_code="fang_com"`；allowlist `("qd.esf.fang.com", "m.fang.com", "esf.fang.com")`（全 https，无 http 例外）；`allowed_insecure_hosts` 不设。
  - `health_check()`：GET 首个列表页测延迟（经 SafeHttp）。
  - `fetch_community_data(community_ids, date_range)`（04B 接口首次真实实现，不再返回 unsupported）：逐小区 GET 列表首页 → 解析房源卡片（总价万→元、单价元/㎡、面积㎡、套数）→ 每套 1 条 `SourceRecord`（object_type=community、fields 含 stat_date=run_date、total_price_yuan、unit_price_yuan_sqm、area_sqm、sample_count=1）；**每小区最多 `MAX_LISTINGS_PER_COMMUNITY=30` 套**；小区无 listing_url → 跳过并计未覆盖；解析失败抛 `ParseError`（稳定 code，不落 HTML）。
  - 限速：请求间 `time.sleep` ≥1s（含 jitter），全 connector 复用 04B 的 timeout/重试/响应体上限。
- **`collectors/property_radar_collectors/run_communities.py`**（`python -m property_radar_collectors.run_communities`）：
  - 参数 `--run-date`、`--api-base`、`--fixture <dir>`（零出网回放）、`--limit N`（只跑前 N 个小区）、`--job-id`（缺省 `qd_fang_<run_date>`）。
  - 流程：`run_guard(fang_com, 370200, community)` → health → `jobs/start` → 逐小区 fetch → `normalize(price_type=listing_ask, metric_code=listing_ask_unit, property_type=resale)`（复用 04B 全部护栏）→ **按小区一个 batch**（`batch_id=qd_fang_<run_date>_<community_id>`，带 observations 数组）→ `jobs/finish(succeeded|failed)`；失败尽力记 failed 非零退出；密钥只读 env。
  - **不进任何 cron/workflow**（仅验证用；daily-collect.yml 不改）。
- **fixture**：合成列表页 HTML（结构复刻实测页面、房源数值自造，**不提交真实页面全文**）≥2 小区；pytest 全走 fixture/MockTransport 零出网。

### R6 验收交付（PRD 验收行）

- **`docs/TASK-04D-小区级数据接入验收报告.md`**：
  - 逐小区表格：`source_id | price_type | sample_count | stat_date | collected_at | quality_status`（真实跑完后从 D1 查询生成，16 行全覆盖或如实标注未覆盖原因）；
  - 覆盖结论复查路径（coverage API 返回、快照行、观测行数、链接清单）；
  - 授权依据章节（负责人裁决原文摘要、执行边界、robots 风险如实记录）；
  - 样本口径说明（首页 ≤30 套、挂牌非成交、stat_date=运行日）。
- 真实数据运行：本地 wrangler dev 先跑通 → 四门禁绿 → 生产部署后对生产 API 再跑一次真实采集（e2e）；本地回放/真实跑的行数如实入报告。

### R7 边界（Out of Scope）

- **04E 保留**：重复/缺字段/极端价格/日期倒退/样本不足/过期 六类清洗 fixture 与规则、统计口径版本化、原始 HTML 不存的强制测试——本任务只做"能落库且聚合正确"的最小实现（确定性 ID 幂等即最小同源去重）。
- 用户端手工录入 UI、贝壳/链家连接器、定时爬取、成交价（closed_transaction）数据、区域级（region）价格、快照历史对比前端改版。

## 3. 验收标准 → 映射

| PRD 验收                                                                             | 达成方式                                                                                                                             |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 对 10–20 个小区建立真实挂牌/成交数据验证管线                                         | R1 种子 16 小区 + R5 真实爬取房天下挂牌列表页 + R2 落库；验收报告逐小区真实数据（至少 10 个小区成功出数，缺链接/解析失败者如实记录） |
| 逐小区给出 source、price_type、sample_count、stat_date、collected_at、quality_status | R3 coverage API 六字段直出 + R6 报告表格（DB 查询生成）                                                                              |
| 每个小区的覆盖结论可复查                                                             | R3 `GET /public/communities/coverage` + 验收报告复查路径章节                                                                         |
| 要求：优先授权 feed / 不实现爬虫                                                     | **用户裁决红线更正（§0-1）**：改为允许房天下公开列表页轻量爬取；执行边界与风险如实入 spec/报告/登记册                                |
| 04B 回归：不存在 arbitrary URL fetch；未 approved 连接器不能运行                     | allowlist 静态校验不变 + `run_guard` 先于一切请求（pytest 回归）                                                                     |

## 4. 风险与回滚

- **风险**：① 房天下页面结构变动/反爬升级导致解析失败——解析器集中一处、fixture 锁结构、失败抛稳定 code 且任务记 failed 不造数；② robots/条款风险——负责人已裁决授权，风险如实记录在登记册与验收报告，不碰贝壳/链家；③ 快照全量重算随观测量增长——当前量级（≤16×30）无虞，04E/后续再优化增量；④ 真实数据入生产库为公开挂牌数据（非个人信息），符合 Public DB 红线；⑤ admin 手工补录写 audit_logs 可追溯。
- **回滚**：代码 `git revert`；种子行可按 city_code/source_id 删除（幂等可重放）；快照/观测行按 source_id 删除即回空态；无新迁移文件、生产 Worker `wrangler rollback` 即回上一版；fang_com 授权状态可经 admin suspend 回 `suspended`。
