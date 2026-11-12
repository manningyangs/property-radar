# Tasks

- [x] Task 1: 数据源授权状态与目录配置
  - [x] SubTask 1.1: `config/sources/data-sources.json`——fang_com 升 approved_licensed（负责人裁决依据入 license_basis/limitations、allowed_automatic、object_levels、metrics、verified_at）+ `user_manual_record.price_type` 校正为 `user_reported`
  - [x] SubTask 1.2: `config/cities/qingdao-community-listings.json` 新建——16 小区 → 房天下列表页 URL 映射（缺链接标 null）
- [x] Task 2: 小区目录种子
  - [x] SubTask 2.1: `db/seeds/0002_qingdao_communities.public.sql`——9 区 regions + 16 小区 communities（确定性 ID cmt_qd_NN、幂等）+ fang_com 授权种子（license_state/coverage×2/approvals/field_verifications）
  - [x] SubTask 2.2: 本地 D1 应用种子并核对（重复执行幂等）
- [x] Task 3: 观测落库与快照聚合模块（API）
  - [x] SubTask 3.1: `apps/api/src/observations.ts`——payload_hash/observation_id 确定性 ID、upsert price_observations、computeStats()（median/mean/p25/p75 线性插值）、全量重算 upsert price_snapshots（ux_price_snapshots_key 冲突覆盖、sample_count≥5 valid 否则 low_sample）
  - [x] SubTask 3.2: `ingestBatchSchema` 增 `observations` 数组（maxItems 500、字段校验、observed_count 一致性）；`POST /internal/ingest/batch` 带观测时落库，响应附 observations_written/snapshots_upserted；门禁/签名/批次幂等回归不变
  - [x] SubTask 3.3: `POST /admin/observations`——admin 门禁 + 单条观测补录（复用 observations 模块）+ audit_logs
  - [x] SubTask 3.4: `public.test.ts`/`internal.test.ts`/`admin.test.ts`——落库幂等、聚合数值（median/p25/p75 边界）、低样本降级、门禁拒绝、批次 duplicate 不重写、admin 补录与审计
- [x] Task 4: 公开 API 验收字段
  - [x] SubTask 4.1: `GET /public/communities/:id/prices` 增 collected_at；新增 `GET /public/communities/coverage?city_code=` 逐小区六字段覆盖结论（无快照 snapshot:null 不造数）
  - [x] SubTask 4.2: public.test.ts——coverage 六字段、未覆盖小区 null、prices 含 collected_at
- [x] Task 5: 房天下小区爬虫连接器与运行 CLI（Python）
  - [x] SubTask 5.1: `fang_community.py`——allowlist 三域名（全 https）、health_check、fetch_community_data（列表首页解析、每小区 ≤30 套、无 URL 跳过、ParseError 稳定 code、限速 ≥1s、不落 HTML）
  - [x] SubTask 5.2: `run_communities.py`——全链（guard→health→jobs start→逐小区 fetch→normalize→按小区 batch(observations)→jobs finish）、失败记 failed 非零退出、密钥只读 env、不入 cron
  - [x] SubTask 5.3: 合成 fixture 列表页（≥2 小区，结构复刻、不提交真实页面全文）
  - [x] SubTask 5.4: pytest——列表解析、超限截断、无 URL 跳过、allowlist 拒绝、MockTransport 全链（含 observations 载荷）、失败路径 job_finish(failed)、既有 81 项回归
- [x] Task 6: 四门禁与本地验收
  - [x] SubTask 6.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿 + `py -m pytest collectors/tests` 全绿
  - [x] SubTask 6.2: 本地验收：wrangler dev 18789（本机动态端口排除 8720–8819，偏离 spec 的 9600/8789）→ 种子 → fixture 回放出数（真实爬取本地/生产均被房天下 JS 挑战阻断，如实记失败不绕过）→ coverage API 逐小区断言 → 浏览器回归（watch/add 真实搜索 + communities 列表 + 演示模式零回归）
- [x] Task 7: 生产部署与真实运行
  - [x] SubTask 7.1: 远端应用 0002 种子（幂等）+ `wrangler deploy`
  - [x] SubTask 7.2: 生产 e2e：真实爬取打生产 API 一次（exit=1 如实 failed/all_communities_failed + health down）→ 生产 fixture 回放（10 批/24 观测/幂等复跑不变）→ 生产 coverage API 冒烟（16 项：10 六字段 + 6 null）
- [x] Task 8: 验收报告、提交与收尾
  - [x] SubTask 8.1: `docs/TASK-04D-小区级数据接入验收报告.md`——逐小区六字段表（DB 查询生成）+ 覆盖复查路径 + 授权依据与风险
  - [ ] SubTask 8.2: 中文 commit `TASK-04D: …`（UTF-8 git commit -F）→ push → CI 绿
  - [ ] SubTask 8.3: §12.0 收尾报告 → checklist 勾选入库 → 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 1] 独立先行（种子与覆盖授权依据其结论）
- [Task 2] depends on [Task 1]
- [Task 3] 独立（可与 1/2 并行）
- [Task 4] depends on [Task 3]
- [Task 5] depends on [Task 1]（源资格）；提交载荷对齐 [Task 3]
- [Task 6] depends on [Task 2, 3, 4, 5]
- [Task 7] depends on [Task 6]（部署在门禁全绿之后）
- [Task 8] depends on [Task 6, 7]
