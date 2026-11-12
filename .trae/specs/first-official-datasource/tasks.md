# Tasks

- [x] Task 1: 核验交付与登记册同步
  - [x] SubTask 1.1: `docs/TASK-04C-青岛市统计局住宅价格指数核验报告.md`——五要素（许可/字段/区域/频率/口径）+ 手工样例核对原始记录（2026-09 期四值、页面结构、发布日期）+ http-only/TLS 处置与风险 + 字段已验证/未验证清单
  - [x] SubTask 1.2: `config/sources/data-sources.json` `qd_stats_price_index` 同步（verified_at/notes/频率与局限按实测校正）
- [x] Task 2: Public 迁移 0003 与迁移测试
  - [x] SubTask 2.1: `db/migrations/public/0003_source_field_verifications.up.sql`/`down.sql`——source_field_verifications（FK、field_code、field_label、metric_code 可空、status CHECK verified/unverified、evidence、verified_at，PK(source_id,field_code)）；IF NOT EXISTS/DROP IF EXISTS 幂等
  - [x] SubTask 2.2: `packages/migrations/src/index.test.ts`——PUBLIC_TABLES +1、表计数更新、新增建表/幂等/状态 CHECK 生效用例
- [x] Task 3: 公开 API 字段验证展示
  - [x] SubTask 3.1: `GET /public/methodology/sources` 附 `field_verifications`（全量含 status）与 `verified_metrics`（仅 verified 且 metric_code 非空去重）
  - [x] SubTask 3.2: `public.test.ts`——unverified 字段不进 verified_metrics 且 status 原样保留；无验证行来源返回空数组
- [x] Task 4: allowlist http 例外（静态 fail closed）
  - [x] SubTask 4.1: `allowlist.py` `assert_url_allowed(..., allow_http_hosts=())`——http 仅限白名单内显式声明且端口 80/默认；其余规则不变；`http.py`/`connector.py` 增 allowed_insecure_hosts 传递通道
  - [x] SubTask 4.2: pytest——http 白名单内放行、http 白名单外拒绝、https 白名单外拒绝、空白名单 fail closed、凭据/非默认端口拒绝（全部零出站）
- [x] Task 5: official_index 归一化扩展
  - [x] SubTask 5.1: `schema.py`——NormalizedObservation 增 `index_value: float|None`；official_index 必填 index_value(0<v<1000)、禁价格字段、stat_date 报告月月末、sample_count 可 0；非 official_index 禁 index_value；原价格规则回归不变
  - [x] SubTask 5.2: pytest——合法指数样本、缺 index_value、指数带金额、非法 stat_date、非指数带 index_value 各抛稳定 code
- [x] Task 6: 青岛连接器与运行 CLI
  - [x] SubTask 6.1: `qingdao_index.py`——SourceConnector 子类：health_check（列表页 GET）、fetch_region_data（列表→date_range 内期次→详情单表格解析→SourceRecord，月末 stat_date，超范围 region 拒绝）、community unsupported、无原始 HTML 落盘
  - [x] SubTask 6.2: `run_daily.py`——参数（run-date/api-base/fixture/job-id）+ 全链流程（guard→health→job_start→fetch→normalize→batch→job_finish，失败尽力 job_finish(failed) 非零退出，密钥只读 env）
  - [x] SubTask 6.3: 合成 fixture（列表+详情 HTML，结构忠实、数值取样例核对值、不提交真实页面全文）
  - [x] SubTask 6.4: pytest——列表/详情解析、date_range 过滤、MockTransport 全链（eligibility→jobs→batch→finish→health 顺序与载荷）、fixture 模式零出网、失败路径 job_finish(failed)
- [x] Task 7: 种子脚本
  - [x] SubTask 7.1: `db/seeds/0001_qingdao_official_index.public.sql` + `.private.sql` 幂等（D1 按库执行，种子按库拆分）——系统审批人 users、cities 370200、data_sources_public + source_license_state(approved_open) + source_city_coverage + source_approvals（§5.3 证据齐全）+ source_field_verifications（4 verified 指标行 + 2 通用行 + 3 unverified 行）
  - [x] SubTask 7.2: 本地 D1 应用种子并核对（重复执行幂等）
- [x] Task 8: 四门禁与本地验收
  - [x] SubTask 8.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿 + `py -m pytest collectors/tests` 全绿
  - [x] SubTask 8.2: 本地验收：起 wrangler dev 9600 + Astro 4321/4322 → 7 运行日回放（fixture，7 个 run-date）→ 查询 ingest_jobs 7 行 succeeded → methodology/sources 字段验证断言 → 浏览器回归（真实模式 + 演示 4322，6/6 PASS）零回归；测试数据按保留口径处理（青岛种子保留，job/batch 回放行保留作验收证据并入报告）
- [x] Task 9: 部署与定时任务
  - [x] SubTask 9.1: 远端补齐迁移（public 0002/0003、private 0003–0006 按序）+ 应用种子；`db:apply:*` 脚本补全为覆盖全部迁移
  - [x] SubTask 9.2: `wrangler deploy` + `wrangler secret put INGEST_HMAC_SECRET`（生成 32 字节 hex，不入仓库/日志）+ `gh secret set API_BASE/INGEST_HMAC_SECRET` + 生产冒烟（eligibility 200 / batch 202 / methodology 含 field_verifications / run_daily 生产 e2e exit=0）
  - [x] SubTask 9.3: `.github/workflows/daily-collect.yml`（cron 10 22 * * * UTC + workflow_dispatch、固定 SHA、collectors 目录运行、Secrets 注入）→ dispatch 真跑成功（run 43186878575，真实访问青岛市统计局站点，`期次=2 观测=4 资格=approved_open 健康=ok`，记真实日历日第 1 日 2026-11-12）
- [x] Task 10: 提交、CI 与收尾
  - [x] SubTask 10.1: 中文 commit `TASK-04C: …`（UTF-8 `git commit -F`，06dd717）→ push → CI 绿（quality + collectors 两跑 success）
  - [x] SubTask 10.2: §12.0 收尾报告（改动摘要/文件/测试/7 回放+真实日口径/风险/回滚）→ checklist 勾选入库 → 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 1] 独立先行（种子与字段验证行依据其结论）
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4/5] 独立（可并行）
- [Task 6] depends on [Task 4, 5]
- [Task 7] depends on [Task 1, 2]
- [Task 8] depends on [Task 3, 6, 7]
- [Task 9] depends on [Task 8]（部署在门禁全绿之后）
- [Task 10] depends on [Task 8, 9]
