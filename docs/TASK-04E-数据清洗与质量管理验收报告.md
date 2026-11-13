# TASK-04E 数据清洗与质量管理验收报告

- 任务：数据清洗、去重与质量管理（PRD 任务行 1312–1318 / spec `data-cleaning-quality`，关联 §4.4/§4.5/§4.7/§5.7/§9.1/§11.1）
- 日期：2026-11-13
- 备份 tag：`pre-v1-p2-task-04e` → 58ba898（TASK-04D 收尾提交）
- 结论：**六类清洗规则、统计口径版本化、官方指数环比双口径落库在本地与生产均验收通过**；四门禁全绿（vitest 159 项 / pytest 100 项），原始 HTML 零泄漏以哨兵测试强制锁死，生产回放幂等与 400 冒烟 6/6 PASS。

---

## 1. 四门禁与测试总览

| 门禁 | 结果 |
|---|---|
| `pnpm typecheck` | ✓ 全绿 |
| `pnpm lint` | ✓ 全绿 |
| `pnpm test`（vitest） | ✓ **159 tests / 8 files**（含 `cleaning.test.ts` 9/9 新增） |
| `pnpm -r build` | ✓ 5 packages 全部通过 |
| `py -3 -m pytest collectors/tests` | ✓ **100 项**（原 96 回归 + HTML 哨兵 4 项新增） |

新增测试文件：`apps/api/src/cleaning.test.ts`（六类 fixture 逐行断言）、`collectors/tests/test_html_sentinel.py`（哨兵 4 项）；`test_run_daily.py` / `test_fang_community.py` 增载荷哨兵与拒绝计数 note 断言。

## 2. 六类清洗 fixture 结果表（规则 → 构造 → 期望 → 实测）

### 2.1 vitest（`cleaning.test.ts`，服务端唯一清洗实现点，本地 D1 断言 DB 行）

| # | 规则 | 构造 | 期望 | 实测 |
|---|------|------|------|------|
| 1 | 重复 | 同观测批内 ×2；同 payload 跨批（不同 batch_id）重提 | 落库 1 行 + `duplicates_dropped=1`；跨批行数不变、payload_hash 稳定 | ✅ 202 `{observations_written:1, snapshots_upserted:1, duplicates_dropped:1}`；跨批复跑行数不变，`observation_id:payload_hash` 匹配 `^[0-9a-f]{32}:[0-9a-f]{64}$` 且前后一致 |
| 2 | 缺字段 | 缺 `stat_date` / 双价皆空 / `area_sqm=0` / 指数无 `index_value` | 全部 400 + 字段级 details，DB 零行 | ✅ 四连发全 400，`details` 指回 `/observations/0` 并点名字段，`price_observations` 计数 0 |
| 3 | 极端价格 | 单价 999999 元/㎡；总价 2 亿元 | 400 details（拍板 1 不落库），DB 零行 | ✅ 400 `validation_failed` + details，零行 |
| 4 | 日期倒退 | 先提 stat_date=T 再提 T−5；再提 T+1 | 旧行入历史、新快照与 prices 首条仍 T；未来日期 400 | ✅ T/T−5 均 202；prices `items[0].stat_date === T`；T+1 → 400「统计日期不得晚于当日（Asia/Shanghai）」 |
| 5 | 样本不足 | 同组 4 套 valid → 补足 5 套 | 4 套 `low_sample`（median 仍算留痕）→ 5 套 `valid` | ✅ `cmt_qd_12` 两步提交：4 套 → `low_sample` median **29500**；第 5 套 → `valid` median **30000** |
| 6 | 过期 | stat_date = 当日−40 天；当日−25 天对照 | 过期组 `quality_status='stale'`、`snapshots_upserted=0`；对照组正常 | ✅ T−40：`stale_count=1`、快照 0；T−25：`valid` 快照 1 |

### 2.2 本地 e2e（wrangler dev 18789，HMAC 直发 + fixture 回放）

六类规则直发 **6/6 PASS**（响应 + DB 行双断言）；`rejected_batches=0`；`method_version` 列可见 04D 残留（`04d-aggregate-v1`）与 04E 新写（`04e-aggregate-v2`）混合——按行留痕、旧序列不改写，符合「口径变更不与旧序列拼接」。

### 2.3 Python 侧（pytest）

- 指数互斥与环比 bounds：`official_index` 禁金额字段、价格类禁 `index_value`，与服务端同阈值同源（`test_schema.py` L128/135/143/149/155 回归绿）。
- 拒绝计数入任务 note：`run_communities` note 含「拒绝=1」；`run_daily` note 断言含「观测=8」且**不含**「拒绝=」（客户端构建期零拒绝，规范拒绝由服务端 400 details 留痕）。
- run_daily 载荷：`observations` 明细长度与 `observed_count` 一致。

## 3. 口径版本说明（R2，唯一真源 `apps/api/src/cleaning.ts`）

| 口径要素 | 值 |
|---|---|
| `METHOD_VERSION` | **`04e-aggregate-v2`**（接入 stale 前置判定；04D 期为 `04d-aggregate-v1`） |
| 极端单价 | `EXTREME_UNIT_PRICE_YUAN_SQM = 100000`（10 万/㎡） |
| 极端总价 | `EXTREME_TOTAL_PRICE_FEN = 1000000000`（1000 万元 = 10 亿分） |
| 小样本分层 | `MIN_VALID_SAMPLES = 5`（<5 → `low_sample`，median 照算留痕） |
| 过期阈值 | `STALE_AFTER_DAYS`：`official_index = 92` 天，其余默认 `30` 天（写入时物化 `stale`） |
| 未来日期界 | Asia/Shanghai 当日（注入 `now` 推导，取沪市当日避免 UTC 早八点误拒） |
| 分位数方法 | median / p25 / p75 线性插值（numpy 默认），聚合只统计 `quality_status='valid'` |
| canonical JSON | **仅 `index_value` 非空时含该键**——既有价格观测 payload_hash/observation_id 计算不变（测试断言） |

任何改变数值或分层结果的口径变更必须同步 bump `METHOD_VERSION`；快照行落列 `method_version`，版本随行可复查。

## 4. 指数双口径落库证据（R3，04C 移交项）

- 迁移：`db/migrations/public/0004_index_value.up.sql`（+ `down.sql`）为 `price_observations` 增 `index_value REAL NULL`；本地与远端 `db:apply` 幂等应用（远端 0004 实测 1 列写入、35 行读）。
- 归一化：`index_observations()` 每期 ×4（新建/二手 × yoy/mom），mom `metric_code` 加 `_mom` 后缀，既有 yoy code 不改名。
- 回放证据（`run_daily --fixture tests/fixtures`，本地 18789 与生产各 8 行，**两处值一致**、全部 `valid`、`official_index` 快照数恒 0）：

| stat_date | metric_code | index_value | quality_status |
|---|---|---|---|
| 2026-08-31 | new_house_price_index | 98.4 | valid |
| 2026-08-31 | new_house_price_index_mom | 100.0 | valid |
| 2026-08-31 | second_hand_price_index | 94.6 | valid |
| 2026-08-31 | second_hand_price_index_mom | 99.8 | valid |
| 2026-09-30 | new_house_price_index | 99.1 | valid |
| 2026-09-30 | new_house_price_index_mom | 100.2 | valid |
| 2026-09-30 | second_hand_price_index | 95.0 | valid |
| 2026-09-30 | second_hand_price_index_mom | 99.9 | valid |

- `official_index` 观测不聚快照：本地/生产 `price_snapshots WHERE price_type='official_index'` 均为 **0**（聚合 SQL 只取 `unit_price_yuan_sqm IS NOT NULL`，天然跳过；`OBS_TO_SNAPSHOT_METRIC` 不新增映射）。

## 5. 原始 HTML 默认不存（R5 强制哨兵测试）

- **14 个 fixture HTML**（fang 11 + 青岛列表 1 + 青岛详情 2）全部埋入哨兵 `SENTINEL_RAW_HTML`（插在 `</body>` 前）。
- `test_html_sentinel.py` 4 项：fixture 全员含哨兵（len==14）→ `SourceRecord.fields` 白名单与 `normalize_record` 产出零哨兵零 `<div`（fang 出卡 ≥24）→ qingdao 列表/详情/指数观测 4 条零页面正文 → 改版页面正文（`SECRET_BODY_04E`）触发 `ParseError` 且**异常消息不含页面内容**。
- 全链载荷断言：`test_run_daily.py` / `test_fang_community.py` 对 `submit_batch` 载荷 JSON 断言零哨兵零 `<div`——100 项 pytest 全绿。

## 6. 生产部署与 e2e（SubTask 6.1 / 6.2）

| 项 | 结果 |
|---|---|
| 远端迁移 | `db:apply:public` 全链执行：0001（19 查询）+ 0002 + 0003 + **0004（1 列写入）**，bookmark 递进 |
| 部署 | `wrangler deploy` 成功，Worker `property-radar-api.yang1-75.workers.dev`，Version ID `7451d9b9-126a-486e-a9d0-40a0baf03038` |
| 指数回放落库 | `run_daily --fixture --run-date 2026-11-11` exit=0、观测=8、资格 approved_open；生产 D1 可见第 4 节 8 行双口径观测（`index_value` 齐全） |
| 幂等复跑 | 同 run-date 第 2 次 exit=0；`idx_rows` 恒 **8**、`obs_total` 恒 34（24 基线 + 2 冒烟 + 8 回放）、`snaps_total` 恒 10——**复跑零新增**；同 batch_id 直发重提 → 202 `{"status":"duplicate"}` |
| 过期冒烟 | T−40 直发 → 202 `{observations_written:1, snapshots_upserted:0, stale_count:1}` |
| 极端 400 | 单价 150000/总价 15 亿分 → 400，details 双字段点名：「单价超出极端上限 100000 元/㎡」「总价超出极端上限 1000000000 分（1000 万元）」 |
| 未来日期 400 | T+1 → 400「统计日期不得晚于当日（Asia/Shanghai 2026-11-13）」 |
| prices method_version | 冒烟前旧快照 `04d-aggregate-v1`；有效观测写入后 → **`04e-aggregate-v2`**，公开 API 逐条返回 |

> **回放日期选型说明（如实记录）**：每日 CI 定时任务 `daily-collect`（schedule 触发，2026-11-13T02:33:38Z）以**已提交的 04D 期旧码**先行消费了当日 batch/job `qd_batch_2026-11-13` / `qd_idx_2026-11-13`（note「观测=4」、只报 observed_count 不发明细 → 该批 0 行，属预期旧行为）。为使 04E 新码明细真正落库，生产验收回放采用空闲的 `--run-date 2026-11-11`；04E 代码 push 后，CI 每日定时任务将自动携带明细落指数观测（run_date 唯一，不与本批冲突）。

## 7. 浏览器零回归（本地）

- `/communities` demo 模式：6 张小区卡片渲染、筛选/排序交互正常（3/3 PASS）。
- `/watch/add` 真实模式（`PUBLIC_DEMO_DATA` 关闭、`PUBLIC_API_BASE` 指 18789）：步骤 1 输入触发实时 `GET /public/cities?q=`（200），`q=青岛` → 建议项「青岛市」；`q=崂山区` → 0 条（步骤 1 为**城市**搜索，本地种子仅北京/杭州/青岛三市，空结果符合设计，API 直查确认 `count=0`）；控制台无 uncaught 错误。

## 8. 风险与回滚

- **迁移**：0004 为可空列 `ALTER TABLE ADD COLUMN`，低风险；回滚走 `0004_index_value.down.sql`（package script `db:down:public` 已含容错）。
- **代码**：`git revert`；Worker `wrangler rollback` 至上一版。
- **数据**：index 观测可按 `source_id='qd_stats_price_index'` 或 `metric_code LIKE '%_mom'` 定位删除；无新密钥（复用 04D 轮换的 `INGEST_HMAC_SECRET` 双端同步值）、无新付费依赖。
- **仓库/日志**：无密钥、无原始页面全文、无个人信息（哨兵测试 + 脱敏日志回归覆盖）。
