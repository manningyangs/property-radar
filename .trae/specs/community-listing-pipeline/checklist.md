# Checklist

## 授权与登记（含红线更正留痕）

- [x] 负责人 2026-11-12 红线更正裁决记录在案：spec §0-1、data-sources.json license_basis、验收报告授权章节三处一致
- [x] fang_com 升 approved_licensed 种子齐全（license_state/coverage×2/approvals §5.3 字段），`user_manual_record.price_type` 校正为 `user_reported`
- [x] 执行边界落实：仅公开列表页、不绕过验证码/登录/访问控制、不存原始 HTML、限速 ≥1s、不入定时任务
- [x] 不碰贝壳/链家；不导入全国全量小区（16 个确定性 ID 种子幂等）

## 小区目录与数据落库（PRD 要求）

- [x] `db/seeds/0002_qingdao_communities.public.sql`：9 区 regions + 16 小区 communities 幂等可重放
- [x] internal `ingest/batch` 携带 observations 落 price_observations：确定性 observation_id 幂等（同观测重复提交不重复行）、observed_count 一致性校验
- [x] 快照聚合：median/mean/p25/p75（线性插值）、sample_count=有效观测数、`ux_price_snapshots_key` upsert；sample_count<5 → quality_status=low_sample（median 仍留痕不静默删除）
- [x] 观测 listing_ask_unit → 快照 community_ask_median_unit 映射为单一代码常量，object_type=community
- [x] `POST /admin/observations` 手工补录：admin 门禁 + 复用同一落库模块 + audit_logs
- [x] 04A/04B 门禁与签名链零回归：签名错/时间戳过期/nonce 重放/pending_review 来源拒绝照旧（既有测试全绿）

## 公开 API 与覆盖复查（PRD 验收）

- [x] `GET /public/communities/:id/prices` 返回 collected_at
- [x] `GET /public/communities/coverage` 逐小区给出 source_id、price_type、sample_count、stat_date、collected_at、quality_status；无数据小区 snapshot:null 不造数
- [x] 小区详情页/列表页浏览器回归：真实数据展示 + 演示模式零回归（04D 无新页面，改验 `/watch/add` 真实搜索 + `/communities` 列表 + 演示分支零回归）

## 爬虫连接器（PRD 要求 + 04B 回归）

- [x] `FangCommunityConnector`：三域名静态 allowlist（全 https、无 arbitrary URL fetch）、每小区 ≤30 套首页样本、无 listing_url 跳过计入未覆盖、ParseError 稳定 code、不落原始 HTML
- [x] `run_communities` 全链：run_guard 先于一切采集请求（未 approved 零出网）→ health → jobs → 按小区 batch → finish；失败记 failed 非零退出；密钥只读 env；**不入 cron/workflow**
- [x] pytest 零出网（fixture/MockTransport）全绿，既有 81 项回归（现 96 项）

## 验收与流程（PRD 验收 + §12.0）

- [ ] 真实爬取 ≥10 个小区成功出数 —— **未达成，如实不勾**：房天下对本环境持续返回 JS 挑战页/HTTP 521，按红线不绕过；本地与生产真实采集均如实 `failed/all_communities_failed`，数据行由生产 fixture 回放产生（口径见验收报告 §3.3），站点防护解除后重跑即可
- [x] `docs/TASK-04D-小区级数据接入验收报告.md`：逐小区六字段表（DB 查询生成）+ 覆盖复查路径 + 授权依据与 robots 风险 + 样本口径说明
- [x] 四门禁全绿：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` + `py -m pytest collectors/tests`（96）
- [x] 生产：远端种子应用 + deploy + 生产 e2e 真实跑一次 + coverage 冒烟
- [x] 无付费依赖新增；仓库/日志无密钥、无真实页面全文、无个人信息
- [x] 中文 commit `TASK-04D: …` → push → CI 绿（run 43203713166，collectors+quality 全绿）；备份 tag `pre-v1-p2-task-04d` 存在
- [x] §12.0 收尾报告输出，checklist 勾选入库，记忆 topics.md / project_memory.md 更新
