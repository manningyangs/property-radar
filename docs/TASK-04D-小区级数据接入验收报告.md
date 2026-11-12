# TASK-04D 小区级数据接入验收报告

- 任务：首批开通城市 10–20 个小区的真实挂牌/成交数据验证管线（PRD 任务行 1304–1310 / spec `community-listing-pipeline`）
- 日期：2026-11-12
- 备份 tag：`pre-v1-p2-task-04d` → 90481d3
- 结论：**管线全链路（采集 → HMAC 签名批次 → 观测落库 → 快照聚合 → 公开 coverage API）在本地与生产均验收通过**；房天下站点对本环境返回 JS 挑战页/HTTP 521，真实出数被阻断，按红线**不绕过、如实记失败**，数据行由 fixture 回放产生（口径已标注）。

---

## 1. 逐小区六字段表（生产 D1 / coverage API 查询生成）

查询方式：`GET /api/v1/public/communities/coverage?city_code=370200`（生产），2026-11-12 拉取；`count=16`，其中 10 个有快照、6 个 `snapshot:null`。

| #   | community_id | 小区         | 区     | source_id | price_type  | sample_count | stat_date  | collected_at        | quality_status                          |
| --- | ------------ | ------------ | ------ | --------- | ----------- | ------------ | ---------- | ------------------- | --------------------------------------- |
| 1   | cmt_qd_01    | 新贵都       | 市南区 | fang_com  | listing_ask | 3            | 2026-11-12 | 2026-11-12 10:43:13 | low_sample                              |
| 2   | cmt_qd_02    | 中海银海一号 | 市南区 | fang_com  | listing_ask | 2            | 2026-11-12 | 2026-11-12 10:43:14 | low_sample                              |
| 3   | cmt_qd_03    | 城市花园     | 市北区 | fang_com  | listing_ask | 3            | 2026-11-12 | 2026-11-12 10:43:15 | low_sample                              |
| 4   | cmt_qd_04    | 浮山后四小区 | 市北区 | -         | -           | -            | -          | -                   | 未覆盖（snapshot:null，00B 清单无链接） |
| 5   | cmt_qd_05    | 幸福花园     | 市北区 | -         | -           | -            | -          | -                   | 未覆盖（snapshot:null，00B 清单无链接） |
| 6   | cmt_qd_06    | 鲁信长春花园 | 崂山区 | fang_com  | listing_ask | 2            | 2026-11-12 | 2026-11-12 10:43:16 | low_sample                              |
| 7   | cmt_qd_07    | 鲁信未央花园 | 崂山区 | fang_com  | listing_ask | 2            | 2026-11-12 | 2026-11-12 10:43:18 | low_sample                              |
| 8   | cmt_qd_08    | 百通馨苑     | 李沧区 | fang_com  | listing_ask | 3            | 2026-11-12 | 2026-11-12 10:43:19 | low_sample                              |
| 9   | cmt_qd_09    | 中海国际社区 | 李沧区 | fang_com  | listing_ask | 2            | 2026-11-12 | 2026-11-12 10:43:20 | low_sample                              |
| 10  | cmt_qd_10    | 卓越蔚蓝群岛 | 城阳区 | fang_com  | listing_ask | 3            | 2026-11-12 | 2026-11-12 10:43:21 | low_sample                              |
| 11  | cmt_qd_11    | 万科城市花园 | 城阳区 | fang_com  | listing_ask | 2            | 2026-11-12 | 2026-11-12 10:43:22 | low_sample                              |
| 12  | cmt_qd_12    | 千禧龙花园   | 黄岛区 | -         | -           | -            | -          | -                   | 未覆盖（snapshot:null，00B 清单无链接） |
| 13  | cmt_qd_13    | 福瀛天麓湖   | 黄岛区 | fang_com  | listing_ask | 2            | 2026-11-12 | 2026-11-12 10:43:23 | low_sample                              |
| 14  | cmt_qd_14    | 德馨珑湖     | 即墨区 | -         | -           | -            | -          | -                   | 未覆盖（snapshot:null，00B 清单无链接） |
| 15  | cmt_qd_15    | 绿城春晓苑   | 胶州市 | -         | -           | -            | -          | -                   | 未覆盖（snapshot:null，00B 清单无链接） |
| 16  | cmt_qd_16    | 宏远金田花园 | 莱西市 | -         | -           | -            | -          | -                   | 未覆盖（snapshot:null，00B 清单无链接） |

- 10 个已覆盖小区样本量 2–3（< 5）→ `quality_status=low_sample`，快照仍留痕不删除，符合 `MIN_VALID_SAMPLES=5` 口径。
- 6 个未覆盖小区在 00B 核验清单中无房天下链接 → 连接器**零请求跳过**（不造数）。

## 2. 覆盖结论复查路径（每个结论可复查）

1. **公开 API**：`GET /api/v1/public/communities/coverage?city_code=370200` → 逐小区 `{community_id, name, district, snapshot: 六字段 | null}`（[public.ts](../apps/api/src/routes/public.ts) `/communities/coverage`，注册先于 `/communities/:id`）。
2. **快照行（生产 D1 radar_public）**：
   `SELECT count(*) FROM price_snapshots WHERE object_type='community' AND metric_code='community_ask_median_unit'` → **10**。
3. **观测行（生产 D1 radar_public）**：
   `SELECT count(*), count(DISTINCT object_id) FROM price_observations WHERE source_id='fang_com'` → **24 / 10**。
4. **链接清单**：[config/cities/qingdao-community-listings.json](../config/cities/qingdao-community-listings.json)——16 小区，10 条 `listing_url`（`https://qd.esf.fang.com/loupan/<id>/chushou/list/`）、6 条 `null`。
5. **批次/任务（生产 D1 radar_private）**：`ingest_jobs` 中 `qd_fang_2026-11-12`（真实跑，`failed`/`all_communities_failed`）、`qd_fang_fx_2026-11-12` 与 `qd_fang_fx2_2026-11-12`（回放，`succeeded`）；`ingest_batches` 各 10 行（batch_id `qd_fang_2026-11-12_<cid>`）。

## 3. 运行结果

### 3.1 本地验收（Task 6）

| 项                                                                        | 结果                                                                                                              |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 四门禁 `pnpm typecheck / lint / test / build`                             | 全绿（API 测试含 04D 新增 internal 5 项、admin 5 项、public coverage 用例）                                       |
| `py -3 -m pytest collectors/tests`                                        | **96 passed**                                                                                                     |
| wrangler dev（端口 18789，本机 8720–8819 动态端口排除区间）+ fixture 回放 | exit=0：批次=10、观测=24、拒绝=1（新贵都极端价护栏）、无链接跳过=6、资格=approved_licensed、健康=ok               |
| 本地 D1 行数                                                              | obs=24 / objects=10 / snaps=10（`cmt_qd_01` median=35754 n=3）；**幂等复跑不变**                                  |
| coverage API                                                              | 16 项（10 六字段 + 6 null），缺 city_code → 400                                                                   |
| 浏览器验收                                                                | PASS：`/watch/add` 搜索“新贵都”命中真实 API 数据（注意 debounce ≈1.5s）、`/communities` 正常渲染、无 console 错误 |

### 3.2 生产部署与 e2e（Task 7）

| 步骤                       | 结果                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 远端 0002 种子（幂等）     | radar_public 7 查询 / radar_private 2 查询执行成功（16 小区 + 9 区 + fang_com 授权）                                                                                                                                                                                                                |
| `wrangler deploy`          | 成功，Version `3e6c8776-8fdf-4ee5-91c1-f06046fc365a`                                                                                                                                                                                                                                                |
| `INGEST_HMAC_SECRET`       | 按 04C 先例**同会话**轮换并双端同步（`wrangler secret put` + `gh secret set`），值不入仓库/日志                                                                                                                                                                                                     |
| 生产授权核验               | `source_license_state(fang_com)=approved_licensed`；`source_city_coverage` 370200 × (community, listing)；`source_approvals=apr_fang_com_0001`                                                                                                                                                      |
| **真实采集（生产，一次）** | **exit=1 如实失败**：10 个有链接小区全部 `retries_exhausted`（房天下 JS 挑战页 `__jsl_clearance_s`/`location.href=location.pathname` + HTTP 521），`ingest_jobs(qd_fang_2026-11-12)=failed/all_communities_failed`，`source_health_reports=down`（detail 记录重试用尽）。**不绕过挑战、不伪造出数** |
| **fixture 回放（生产）**   | exit=0：`qd_fang_fx_2026-11-12` 与 `qd_fang_fx2_2026-11-12` 各 批次=10、观测=24、拒绝=1、跳过=6；**两跑幂等：obs/snaps 恒 24/10 不变**                                                                                                                                                              |
| 生产 coverage 冒烟         | `count=16`，10 项六字段齐全、6 项 null（见第 1 节表）                                                                                                                                                                                                                                               |

> 口径声明：第 1 节表中的数据行由**生产 fixture 回放**产生（结构复刻的合成列表页，零出网、不存真实页面全文）；真实采集的结果是**如实失败记录**（上表）。二者在 `ingest_jobs.job_id` 上可区分（`qd_fang_2026-11-12` vs `qd_fang_fx*_2026-11-12`）。

### 3.3 PRD 验收项“真实爬取 ≥10 个小区成功出数”——未达成，如实标注

房天下对本执行环境（含普通浏览器 UA 的直连请求）持续返回 JS 挑战页/HTTP 521。按 2026-11-12 负责人裁决的执行边界，**识别并如实报告，不绕过验证码/访问控制**。因此真实出数在当前网络环境下不可得；管线真实性由“真实采集请求确实发出并如实记失败 + 生产 API 全链受理”证明，数据正确性由 fixture 回放的生产 D1 行证明。站点防护解除后重跑 `run_communities` 即可在生产产生真实数据（幂等设计，不产生重复行）。

## 4. 授权依据与风险

- **负责人裁决（2026-11-12，PRD 行 1308 红线更正）**：原红线“不实现爬虫”为笔误，负责人拍板“**按我说的来，爬虫获取**”——授权对房天下公开挂牌列表页做轻量爬取，**仅做验证用**。裁决同时确认管线形态为 admin/internal API + seed、落库口径为“观测+快照都写”。
- **执行边界**：仅 GET 公开列表页；主机白名单 `qd.esf.fang.com / m.fang.com / esf.fang.com` 全 https（静态类属性，任何网络 I/O 前强制，白名单外 fail closed）；限速 ≥1s/请求（SafeHttpClient 默认）；每小区仅列表首页 ≤30 套；不存原始 HTML；不绕过验证码/登录/访问控制；**不碰贝壳/链家**；**不入 cron**（`ci.yml` daily-collect 仅含 04C 官方指数任务，04D 无定时任务）。
- **robots/站点防护风险**：房天下返回 521 与 JS 挑战页，表明站点对自动化访问有防护；本实现选择**不绕过**，如实记为 `down`/`failed`。若站点 robots 或防护策略收紧，应经 admin `suspend` 将 `fang_com` 置为 `suspended` 即可全局停收（门禁四段自动拒绝），无需回滚代码。
- **登记册**：`config/sources/data-sources.json` 已同步授权状态与执行边界说明；私有库 `source_approvals=apr_fang_com_0001`（approved_licensed，仅 370200）。

## 5. 样本口径说明

- **挂牌非成交**：`price_type=listing_ask`（挂牌要价），`metric_code=listing_ask_unit`（单价元/㎡），聚合落 `community_ask_median_unit`；**成交价（closed_transaction）本任务不做**（R7 out of scope）。
- **样本量**：每小区仅取列表首页 ≤30 套；本表样本 2–3 套是 fixture 每页 2–3 套卡的直接结果。
- **stat_date = 运行日**（`--run-date`，缺省 Asia/Shanghai 今日）；`collected_at = datetime('now')` 落库时间（幂等重跑会刷新为最新一次成功采集时间）。
- **质量分层**：`sample_count>=5 → valid`，否则 `low_sample`（中位数/分位仍留痕）；0 条有效单价不写快照（不造数）。
- **去重/幂等**：`observation_id = SHA-256(source|object|price_type|metric|stat_date|payload_hash)` 前 32 hex，同内容重交 `ON CONFLICT DO UPDATE` 不产生重复行；快照按 `(object_type, object_id, price_type, metric, stat_date)` upsert、受影响组全量重算。
- **护栏**：极端价格（如 150,000 元/㎡、2000 万级）在归一化层拒绝并如实计数（本地/生产各拒绝 1 条），不影响该小区其余样本。

## 6. 门禁与测试汇总

- 四门禁：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿。
- pytest：**96 passed**（含解析、截断 30、挑战页识别、配置 16=10+6、全链签名对拍、403 零采集、全量失败 job failed、`--limit`、缺参退出码、`--fixture` 零出网）。
- API 测试：04D 新增——batch 观测落库聚合（5 套精确统计/低样本/幂等/duplicate 不重写/observed_count 400/maxItems 500/门禁 403 零落库）、admin 补录（201+审计+幂等+400/404/403）、coverage 六字段+null+400、prices `collected_at`、PRIVATE_LEAK 路径回归。
- 无付费依赖新增；仓库/日志无密钥（HMAC 值仅存 Wrangler/GitHub Secrets）、无真实页面全文、无个人信息。

## 7. 回滚

- 代码：`git revert <TASK-04D commit>`。
- 无新迁移文件（复用 0001–0006），数据库无需逆序迁移。
- 种子行：按 `city_code=370200`（communities/regions）与 `source_id='fang_com'`（license_state/coverage/approvals/field_verifications）删除即可（幂等可重放）。
- 数据行：`DELETE FROM price_observations WHERE source_id='fang_com'`、`DELETE FROM price_snapshots WHERE object_id LIKE 'cmt_qd_%'` → 回空态。
- 生产 Worker：`wrangler rollback` 回上一版；`fang_com` 可经 admin `suspend` 全局停收。
- 生产任务测试数据按 PRD 记入不清理（真实失败 job、回放批次与观测行均为验收证据）。
