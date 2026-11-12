# SPEC: TASK-04C 首个官方数据源（青岛市统计局住宅价格指数）

> PRD 任务书 V1.2 · 任务行 1296–1302 · 关联 §5.2 状态机 / §5.3 审核清单 / §5.5 政府和统计数据 / §5.6 连接器规范 / §6.6 定时任务 / §9.1 data_sources_public / §10.4 导入 API / §11.1 日更流程

## 0. 用户已拍板的三项范围决策

1. **数据源**：`qd_stats_price_index`（青岛市统计局 住宅价格指数，approved_open，官网免费公开、月更）。
2. **7 运行日验收**：**本地回放 7 个运行日**——用结构忠实的合成 fixture 连续执行 7 个不同 run-date 的完整运行（含调度仿真语义），`ingest_jobs` 落 7 行 succeeded 状态记录；同时生产每日 schedule 真实上线，从上线日起按真实日历日继续累计（收尾报告如实区分「回放 7 日」与「真实日历日第 N 日」）。
3. **运行目标**：**本任务先部署生产 API**——补齐远端 D1 迁移、`wrangler deploy`、`wrangler secret put INGEST_HMAC_SECRET`、GitHub Actions 配 `API_BASE`/`INGEST_HMAC_SECRET` 两个 Secret，每日任务与验收冒烟打真实生产 D1。

## 1. 背景与现状（调研结论）

- 青岛市统计局住宅价格指数栏目（`http://qdtj.qingdao.gov.cn/tongjisj/tjsj_42452/tjj_tjsj_jgzs/zzjgzs/`）为列表页 + 每期详情页（.shtml），**全站 http，TLS 证书与主机名不匹配（https 报 ERR_TLS_CERT_ALTNAME_INVALID）**，页面 UTF-8。
- **手工样例核对（2026-11-03 发布的「住宅销售价格指数2026年9月」期，实测于对接前）**：单表格结构——`报告期：2026年9月`；表头 `指标名称 | 本月(上年同月=100) | 环比(上月=100)`；数据行 `新建商品住宅销售价格指数 99.1 / 100.2`、`二手住宅销售价格指数 95.0 / 99.9`；表注 `数据来自国家统计局青岛调查队`；来源 `青岛市统计局`、发布日期 `2026-11-03`。
- 生产 D1 现状：private 停在 0002（缺 0003/0004/0005/0006），public 停在 0001（缺 0002），`cities` 0 行；仓库无任何 GitHub Secret、生产 Worker 未部署。本地 D1 已含全部既有迁移。
- `ingest/batch` 只受理批次元数据（`observed_count`），**不落观测明细**；`price_observations` 无 index 数值列——观测持久化属 04E/04D，本任务不建。
- 现有公开来源展示面为 API `GET /public/methodology/sources`（暂无前端页面），是「已验证指标」的展示载体。

## 2. 需求（In Scope）

### R1 核验交付（PRD「要求」+ 手工样例核对）
- 新增 `docs/TASK-04C-青岛市统计局住宅价格指数核验报告.md`，覆盖五要素：**开放许可**（license_basis/license_url/转载注明出处要求）、**数据字段**（逐字段列已验证/未验证）、**区域范围**（青岛市全市，市辖区口径；无区县/小区字段）、**更新频率**（月更，实测 2026-11-03 发布 2026-09 期）、**统计口径**（同比=上年同月100、环比=上月100、指数非元/㎡、样本量不公布）；附手工样例核对原始记录（上表四值 + 页面结构）与 http-only/TLS 证书失效的处置说明。
- `config/sources/data-sources.json` 中 `qd_stats_price_index` 条目同步：`verified_at` 更新、`notes` 注明连接器已接入与核验报告位置、频率/局限按实测校正。

### R2 字段验证状态（PRD 验收②：未验证字段不展示为已验证指标）
- **Public 迁移 `0003_source_field_verifications`**：`source_field_verifications(source_id FK→data_sources_public, field_code, field_label, metric_code 可空, status CHECK verified/unverified, evidence, verified_at, PRIMARY KEY(source_id,field_code))`；IF NOT EXISTS 幂等、down 干净。不 ALTER 既有表（先例约束）。
- `GET /public/methodology/sources` 每条来源附：
  - `field_verifications`: 全量字段行（含 `status` 原值）；
  - `verified_metrics`: **仅** status=`verified` 且 metric_code 非空的去重指标数组。
  - 任何 status=`unverified` 的字段行不得进入 `verified_metrics`，其自身 `status` 保持 `unverified`。
- 种子写入青岛源字段验证行（来自 R1 手工样例核对）：
  - verified：`new_build_yoy_index`(new_house_price_index)、`new_build_mom_index`(new_house_price_index)、`resale_yoy_index`(second_hand_price_index)、`resale_mom_index`(second_hand_price_index)、`report_period`(null)、`publish_date`(null)——evidence 记录 2026-09 期实测样例值；
  - unverified：`base_index`（定基指数，页面无此列）、`district_level_index`（区县级指数，页面无）、`transaction_price`（成交价字段，页面无）——明确不展示为已验证。
- 验收测试：注册/种子混合状态 → API 断言 `verified_metrics` 只含已验证指标、unverified 行原样保留且不计入。

### R3 青岛连接器（PRD「接入一个已确认开放的官方数据源」）
- **allowlist http 例外（静态、fail closed）**：`assert_url_allowed(url, allowed_hosts, *, allow_http_hosts=())`——https 规则不变；http 仅当 `hostname ∈ allowed_hosts 且 hostname ∈ allow_http_hosts` 且端口 80/默认；其余（http 白名单外、非 443/80、凭据、空白名单）照旧零网络调用抛 `allowlist_violation`。`SafeHttpClient` 与 `SourceConnector` 增 `allowed_insecure_hosts` ClassVar 通道。青岛连接器显式声明 `("qdtj.qingdao.gov.cn",)`，并在核验报告记录 http-only 事实与风险（明文传输，数据为公开统计指数）。
- **official_index 归一化扩展**（schema.py）：`NormalizedObservation` 增可空 `index_value: float | None`；`normalize_record` 当 `price_type=="official_index"` 时——`index_value` 必填（数值，0<值<1000）、禁止携带 `total_price_yuan`/`unit_price_yuan_sqm`（口径红线：指数不是金额，§53 校验）、`stat_date` 为报告月**月末**（YYYY-MM-DD）、`sample_count` 允许 0（来源不公布样本量，禁止造数）；非 official_index 路径禁止携带 `index_value`，原有价格规则不变。落库映射留 04E。
- **`QdStatsIndexConnector`（collectors/property_radar_collectors/qingdao_index.py）**：
  - `source_code="qd_stats_price_index"`（= source_id）、白名单 `qdtj.qingdao.gov.cn`（http 例外）、`connector_version` 语义化递增、`supports_community=False`（无社区字段 → `fetch_community_data` 返回 `unsupported` 不伪造）。
  - `health_check()`：GET 栏目列表页（经 SafeHttp，测延迟）→ `SourceHealth`。
  - `fetch_region_data(region_ids, date_range)`：列表页解析（条目标题/链接/发布日期）→ 仅取 `date_range` 内期次 → 逐期 GET 详情页 → 解析单表格 → 每期产出 1 条 `SourceRecord`（fields：`stat_date` 月末、`report_period`、`new_build_yoy_index`/`new_build_mom_index`/`resale_yoy_index`/`resale_mom_index`、`publish_date`、`source_note`），**不落原始 HTML**（§5.7）。region_ids 仅含授权城市（370200），超范围即拒。
  - 解析失败 → `ParseError`；缺表/缺行 → `ValidationError`；均带稳定 code 与脱敏消息。
- **运行 CLI `collectors/property_radar_collectors/run_daily.py`**（`python -m property_radar_collectors.run_daily`，cwd=collectors）：
  - 参数：`--run-date YYYY-MM-DD`（默认今日 Asia/Shanghai）、`--api-base`（缺省 `$API_BASE`）、`--fixture <目录>`（离线回放：提供列表页+详情页合成 HTML，零出网）、`--job-id`（缺省 `qd_idx_<run_date>`）；密钥只读环境变量 `INGEST_HMAC_SECRET`。
  - 流程：`run_guard`(eligibility, city 370200, level city) → `health_check` → `report_health` → `job_start` → `fetch_region_data` → 逐条 `normalize`(official_index ×2 指标) → `submit_batch`(batch_id=`qd_batch_<run_date>`, observed_count=条数) → `job_finish(succeeded, note=run_date+期次+条数)`；任何一步 ConnectorError/内部错误 → 尽力 `job_finish(failed, error_code)` 并非零退出（job_start 前失败则直接非零退出，零采集请求）。
- **fixture**：`collectors/tests/fixtures/` 增合成列表页与详情页 HTML（结构复刻实测页面、数值取样例核对四值；**不提交真实抓取的原始页面全文**，§5.7/04E 红线）。pytest 全部走 fixture/MockTransport，不出网；真实出网仅存在于 run_daily 实跑（workflow/验收）。

### R4 种子与生产部署（运行目标）
- **`db/seeds/0001_qingdao_official_index.sql`**（幂等 INSERT/ON CONFLICT，本地与远端同一文件）：
  - `users` 系统引导审批人（`u_system_ops`，非真实邮箱如 `system@radar.internal`）——满足 `source_approvals.approver_user_id` FK；
  - `cities` 370200 青岛市（province 370000，status/catalog_status active，coverage_level city，coverage_note 注明仅市级官方指数）；
  - `data_sources_public`（qd_stats_price_index，data_scope/display_scope 只写已验证字段范围）+ `source_license_state`(approved_open) + `source_city_coverage`(370200/city/metric_codes=[new_house_price_index,second_hand_price_index]/approved_open) + `source_approvals`（§5.3 证据：evidence_ref=license_url、permitted_fields/purposes、frequency monthly、retention、valid_until 按复核日期、status_after approved_open、note 注明引导审批与核验报告）+ `source_field_verifications`（R2 行）。
- **部署序列**（实施后期执行，命令不入库）：远端补迁移 public 0002→0003、private 0003→0004→0005→0006（按序 wrangler d1 execute --remote）→ `pnpm --filter @property-radar/api build`（dry-run 过）→ `wrangler deploy` → `wrangler secret put INGEST_HMAC_SECRET`（本地生成 32 字节 hex，不入仓库/日志）→ 远端应用 seed → `gh secret set API_BASE / INGEST_HMAC_SECRET` → 生产冒烟：eligibility 200 / jobs start+finish 202 / batch 202 / methodology/sources 含 field_verifications。
- **`apps/api/package.json` 的 `db:apply:*` 脚本**仅列 0001/0003 与实际不符——本任务顺手补全为按序覆盖全部迁移文件（远端 apply 命令的仓库化入口）。

### R5 每日定时任务（§6.6）
- 新增 `.github/workflows/daily-collect.yml`：`schedule: cron '10 22 * * *'`（UTC = 北京 06:10）+ `workflow_dispatch`（输入可选 run-date）；job = checkout（固定 SHA，与 ci.yml 一致）→ setup-python（固定 SHA `a26af69be951a213d495a4c3e4e4022e16d87065`）→ pip install -r → `python -m property_radar_collectors.run_daily`（working-directory collectors，env：`API_BASE`/`INGEST_HMAC_SECRET` 来自 Secrets）；permissions contents:read；失败由 Actions 邮件告警（§6.6 失败告警）。
- prettier 通过（`.github/**/*.yml` 在 lint 范围）。
- 验收：部署后手动 `workflow_dispatch` 真跑一次（真实网络访问青岛市统计局站点 + 打生产 API），作为生产真实日历日第 1 日记录；若 GitHub Actions 无法访问该站点，如实记录为风险并保留手动/本地运行路径（不伪造成功）。

### R6 7 运行日回放（验收①执行动作）
- 临时回放脚本（%TEMP%，不入库）：对本地 wrangler dev（9600，`.dev.vars` 既有 secret）以 `--fixture` 连续执行 7 个 run-date（2026-11-05 ~ 2026-11-11）的 `run_daily`，每次独立 job_id/batch_id；结束后查询本地 `ingest_jobs` 输出 7 行（source_id=qd_stats_price_index、status=succeeded、started/finished 非空、error_code 空）作为验收证据（写入收尾报告）。本地已先应用 0001 种子。
- 生产侧同步保留真实每日 schedule（上线起累计真实日历日）。

### R7 文档与边界
- `collectors/README.md` 增：青岛连接器结构、http 例外声明、`run_daily` 用法（real/fixture）、密钥与 API_BASE 环境变量。
- **Out of scope**：price_observations/snapshots 落库与清洗（04E）、小区级接入（04D）、methodology 前端页面与 admin 字段验证管理端点（06B/06C）、规则计算与通知（05）、Cloudflare Pages 生产前端部署。

## 3. 验收标准 → 映射

| PRD 验收 | 达成方式 |
|---|---|
| 至少连续 7 个运行日记录任务状态 | R6：本地回放 7 个 run-date，`ingest_jobs` 7 行 succeeded（用户拍板方案）；R5：生产每日 schedule 上线后按真实日历日继续累计（报告区分口径） |
| 任何字段未验证则不展示为已验证指标 | R2：`source_field_verifications` + `verified_metrics` 仅由 status=verified 推导，unverified 行原样保留；API 测试断言；核验报告逐字段列验证结论 |
| 要求：核验许可/字段/区域/频率/口径 + 手工样例核对 | R1 核验报告五要素 + 样例四值原始记录 |
| 要求（隐含，§5.6）：连接器走白名单与门禁 | R3：http 例外仍静态 fail closed；run_guard 先于一切采集请求；04B 两验收回归保持 |

## 4. 风险与回滚

- **风险**：① GitHub Actions 访问青岛市统计局站点可能失败（境外 runner/站点策略）——dispatch 真跑实测，失败如实入报告并保留手动运行；② GitHub schedule 私有仓库 60 天无活动会暂停、高负载延迟丢弃（§6.6 已知）；③ http 明文传输——仅限该官方统计页、主机写死、记录于核验报告；④ `wrangler deploy`/远端 d1 偶发 fetch failed——重试即可（既往经验）；⑤ 生产 secret 生成后仅存于 Wrangler/GitHub Secrets，任何日志/报告不出现值。
- **回滚**：代码 `git revert`（含 0003.down 逆序执行）；生产 Worker `wrangler rollback` 或删除脚本；daily workflow 删除/disabled；D1 迁移按 down 逆序（0006→0003、public 0003→0002）；seed 行可按 source_id/city_code 删除（幂等可重放）。
