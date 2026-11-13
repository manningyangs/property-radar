# SPEC: TASK-04E 数据清洗、去重与质量管理

> PRD 任务书 V1.2 · 任务行 1312–1318 · 关联 §4.4 小区挂牌统计 / §4.5 房源去重 / §4.7 数据质量状态 / §11.1 日更流程（步骤 3–4 标准化与去重/异常检测/日期校验）/ §5.7 原始 HTML / §9.1 price_observations+price_snapshots / §4.6-7 口径断点

## 0. 用户已拍板的四项范围决策（2026-11-13）

1. **异常留痕形态 = 仅计数留痕，不落库、不加迁移**：极端价格等异常不新增拒绝原因列、不落 `rejected` 观测行。留痕落在两处——Python 端 normalize 逐条拒绝并计数入任务 note（04D `run_communities` 已有「拒绝=N」）；服务端清洗前置校验整体 400 拒绝并返回字段级 `details`（响应即留痕）。PRD §4.4「保存异常原因和处理结果」以响应 details + 任务 note 的可查记录满足。
2. **过期（stale）= 写入时物化**：写观测时按阈值判定并写死 `quality_status='stale'`；阈值集中为常量、按 `price_type` 区分——`official_index` = 92 天（月度来源 stat_date 天然滞后一个季度以内），其余 = 30 天。物化时刻判定即结论；「随时间自动变陈旧」的重算任务不在本任务。
3. **统计日期倒退 = 未来日期拒绝、旧日期入历史**：`stat_date` 晚于 Asia/Shanghai 当日 → 400 拒绝（造假防护，取沪市当日避免 UTC 早八点误拒）；早于组内最新快照的倒退数据照常入库为独立历史行（唯一键含 stat_date），最新展示按 `stat_date DESC` 天然不被覆盖。
4. **04C 遗留环比双口径纳入本任务**：`qingdao_index.py` 注释明确「双口径落库映射属 TASK-04E」——环比列归一化为第二指标观测并真正落库（需 public 迁移新增 `index_value` 列，因 `price_observations` 目前无处存放指数值）。

## 1. 背景与现状（调研结论）

- 04D 已交付：`observations.ts`（SHA-256 确定性 ID 幂等 upsert、`computeStats()` 线性插值、快照全量重算、`method_version` 落列 `04d-aggregate-v1`）、`ingest/batch` 携带 observations 数组、`POST /admin/observations` 手工补录、coverage/六字段公开 API。
- **已有护栏**（不重复造轮子，本任务用 fixture 测试锁死而非重写）：
  - Python `schema.py`：枚举/必填/stat_date 格式、金额正数与极端上限（总价 1000 万/套、单价 10 万/㎡、指数 ≤1000）、指数禁金额、元→分换算；
  - 服务端 `schemas.ts` JSON Schema + `assertObservationSemantics()`（总价与单价至少一非空、area>0）；
  - 快照 `sample_count ≥ 5 → valid` 否则 `low_sample`（04D 已实现）。
- **缺口（本任务的新代码）**：
  - 服务端无极端价格校验、无未来日期校验、无过期判定、无批内重复去重计数——六类规则没有成体系的 fixture 验收；
  - `method_version` 是散落代码常量，未集中版本化管理、公开 API 不返回；
  - 官方指数观测**从未落库**：`price_observations` 无 `index_value` 列；`run_daily` 只报 `observed_count` 不发明细（04C 设计时 04D 尚未落地）；环比列滞留 `SourceRecord.fields`；
  - 「原始 HTML 默认不存」只有实现自觉（04D/04C 注释），无强制测试。

## 2. 需求（In Scope）

### R1 清洗规则模块（服务端唯一实现点）

**`apps/api/src/cleaning.ts`**（纯函数、时钟 `now` 可注入供测试；internal 批次与 admin 补录两条路径共用，**先于任何 DB 写执行**——400 时零行落库）：

1. **缺字段/语义**（承接并扩展 `assertObservationSemantics`）：总价与单价至少一项非空；`area_sqm` 非空必须 > 0；**指数互斥**——`price_type='official_index'` 必须携带 `index_value`（0 < v ≤ 1000）且不得携带金额字段（`price_total_fen`/`unit_price_yuan_sqm`/`area_sqm`），价格类观测不得携带 `index_value`（与 Python normalize 同口径）。
2. **极端价格**（服务端防线，阈值与 Python 同源、单一常量导出）：`unit_price_yuan_sqm > 100000`（10 万/㎡）或 `price_total_fen > 1000000000`（1000 万元 = 10 亿分）→ 400 `validation`，`details` 逐条列出字段路径。
3. **未来日期**：`stat_date > Asia/Shanghai 当日`（由注入 `now` 推导）→ 400 `validation`。
4. **过期物化**（拍板 2）：`stat_date < 当日 − STALE_AFTER_DAYS[price_type]`（`official_index=92`、默认 `30`）→ 该观测 `quality_status` 覆盖为 `'stale'` 后照常入库（留痕）；因聚合只统计 `quality_status='valid'`（PRD §4.4「未确认过期的样本」），过期组无有效样本 → **不写快照**（`snapshots_upserted=0`，不造数）。组内 stat_date 同键，故整组同为过期或新鲜，无混合态。
5. **重复**：批内按确定性 `observation_id` 先去重（响应附 `duplicates_dropped` 计数）；跨批同 payload 重提走 04D 既有 `ON CONFLICT DO UPDATE` 幂等（行数不变）。
6. **模块产出**：`{ cleaned: ObservationInput[], duplicates_dropped, stale_count }` 或抛 400 `validation`；`MIN_VALID_SAMPLES=5`、`STALE_AFTER_DAYS`、极端阈值全部集中在本模块导出。

### R2 统计口径版本化（PRD 要求）

- 口径要素集中导出并成为唯一真源：`METHOD_VERSION`、`MIN_VALID_SAMPLES`、`STALE_AFTER_DAYS`、`OBS_TO_SNAPSHOT_METRIC`、percentile 口径说明（median/p25/p75 线性插值，numpy 默认）。
- `METHOD_VERSION` 随本任务口径变更升为 **`04e-aggregate-v2`**（接入 stale 前置判定）；规则：任何改变数值或分层结果的口径变更必须 bump 版本——快照行落列已有，版本随行即可复查。
- 公开 `GET /public/communities/:id/prices` 返回的快照对象补 `method_version` 字段。
- 验收报告单列口径说明（版本号、阈值、分位数方法、过期阈值）；「口径变更不与旧序列拼接」的断点展示（§4.6-7）属前端/后续，本任务只保证版本随行。

### R3 官方指数环比双口径落库（04C 移交项）

- **迁移 `db/migrations/public/0004_index_value.up.sql`（+`down`）**：`price_observations` 增 `index_value REAL NULL`（应用层 0<v≤1000 校验；如 SQLite `ALTER TABLE ADD COLUMN` 允许则附 CHECK，实施期验证）。
- **Python `index_observations()`**：每期产出 4 条观测（新建 yoy/mom、二手 yoy/mom）；mom `metric_code` = `new_house_price_index_mom` / `second_hand_price_index_mom`（既有 yoy code `new_house_price_index`/`second_hand_price_index` 不改名，避免破坏登记册种子与既有测试）；文件头「供 04E」注释同步更新。
- **`schemas.ts OBSERVATION_ITEM`**：增 `index_value`（number|null，exclusiveMinimum 0、maximum 1000）；R1 指数互斥语义校验。
- **`observations.ts`**：INSERT 增列；**canonical JSON 仅在 `index_value` 非空时包含该键**——既有价格观测的 payload_hash/observation_id 计算结果不变，生产已有行复跑幂等不重复。
- **聚合边界**：`official_index` 观测不聚快照（`price_snapshots` 是价格统计口径，median/分位数对单源指数无意义）——聚合 SQL 本就只取 `unit_price_yuan_sqm IS NOT NULL`，天然跳过；OBS_TO_SNAPSHOT_METRIC 不新增映射，注释写明。
- **`run_daily.py`**：`submit_batch` 改为携带 observations 明细（`observed_count=len(observations)` 不变）——04C 指数观测自此真正落库；CI 每日定时任务沿用（`approved_open` 官方开放数据，符合红线），不新增 workflow。

### R4 六类清洗 fixture（PRD 验收核心）

**TS 侧 `apps/api/src/cleaning.test.ts`**（沿用既有测试基座；fixture 数据内联或 `apps/api/src/fixtures/`）：

| # | 类别 | 构造 | 断言（结果符合规则） |
|---|------|------|---------------------|
| 1 | 重复 | 同观测批内 ×2；同 payload 跨批（不同 batch_id）重提 | 落库 1 行、`duplicates_dropped=1`；跨批行数不变、payload_hash 稳定 |
| 2 | 缺字段 | 缺 stat_date；双价皆空；area≤0；指数无 index_value | 全部 400 + 字段级 details，DB 零行 |
| 3 | 极端价格 | 单价 999999 元/㎡；总价 2 亿元 | 400 details（拍板 1 不落库），DB 零行 |
| 4 | 日期倒退 | 先提 stat_date=T 再提 T−N；再提 T+1 | 旧行入历史且新快照仍为 T、prices 按 stat_date DESC 最新=T；未来日期 400 |
| 5 | 样本不足 | 同组 4 套 valid → 再补 1 套 | 4 套快照 `low_sample`（median 仍算留痕）；5 套转 `valid` |
| 6 | 过期 | stat_date = 当日 − 40 天（默认阈值外）提交 | 观测行 `quality_status='stale'`、`snapshots_upserted=0`；阈值内对照组正常 valid |

**Python 侧 pytest**：极端价格 normalize 拒绝并计入任务 note（既有 + 断言 note 含「拒绝=」）、指数互斥/环比 bounds、`run_daily` 载荷含 observations 且与 observed_count 一致、双口径 4 条归一化正确。

### R5 原始 HTML 不存的强制测试

- 向 fang 与 qingdao_index 的 fixture HTML 埋哨兵串（如 `SENTINEL_RAW_HTML`），pytest 断言：`SourceRecord.fields`、`NormalizedObservation`、`submit_batch` 载荷 JSON 均不含哨兵串与 `<div` 等标记；`ParseError` 异常消息不含页面正文。
- 04D/04C 已有「不落 HTML」实现，本任务以测试强制锁死（PRD 要求「原始 HTML 默认不存」）。

### R6 回归与边界

- 04A/04B/04C/04D 全量回归：签名链/时间戳/nonce、run_guard 未 approved 零出网、批次 duplicate 202、coverage 六字段、96 pytest、既有 vitest 全绿。
- **Out of Scope**：异常落库与原因列（拍板 1 否决）、随时间自动变陈旧的重算任务、用户端/管理端 UI（质量后台属 06D）、跨平台房源匹配（§4.5 V1 不做）、环比值前端展示、阈值管理后台化。

## 3. 验收标准 → 映射

| PRD 04E 验收/要求 | 达成方式 |
|---|---|
| 面积单位/价格单位统一 | 既有 Python 换算（元→分、万→元）+ 服务端互斥/范围校验（R1-1/R1-2），fixture #2/#3 锁死 |
| 异常数据留痕 | 拍板 1：400 details + 任务 note 计数（R1-2、R4 #3、pytest note 断言） |
| 同源去重 | 确定性 ID 跨批幂等（04D）+ 批内去重计数（R1-5），fixture #1 |
| 统计口径版本化 | R2：常量集中、`04e-aggregate-v2`、公开 API 返回 method_version |
| 小样本降级 | 既有 `MIN_VALID_SAMPLES=5` 归入清洗模块唯一真源，fixture #5 |
| 原始 HTML 默认不存 | R5 强制哨兵测试 |
| 验收：六类 fixture 结果全部符合规则 | R4 两张测试表逐行断言 + 验收报告记录实测输出 |
| 04C 移交：环比双口径落库 | R3 迁移 + 双指标归一化 + run_daily 发明细 + 生产回放可见 4 类指数行 |

## 4. 风险与回滚

- **风险**：① 迁移 0004 生产库 `ALTER TABLE ADD COLUMN`（SQLite 低风险、可空列无表锁问题）；② canonical 条件键若实现不慎会改变既有观测 hash → 生产 24 行 fixture 观测复跑产生重复行——测试必须断言既有价格观测 ID 稳定；③ 过期阈值为工程拍板值（30/92 天）——集中常量 + 验收报告记录，调整留待管理后台（06D）；④ `run_daily` 开始发明细后 CI 每日真实落指数观测——`approved_open` 官方开放数据，符合红线；⑤ CI 每日运行遇同 run_date 批次 duplicate 202 属正常（04A 行为）。
- **回滚**：代码 `git revert`；迁移走 `0004_index_value.down.sql`；生产 Worker `wrangler rollback`；index 观测行可按 `metric_code LIKE '%_mom'` 或 source_id 删除。无新密钥、无新付费依赖。
