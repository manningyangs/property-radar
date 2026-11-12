# TASK-04B 通用 Connector 框架 Spec

> PRD 任务书 V1.2 · 任务行 1288–1294 · 关联 §5.6 连接器规范 / §5.7 原始数据留存 / §9.1 price_observations / §10.4 数据导入 API / §11.1 日更流程 / §12.0-10
> 备份 tag：`pre-v1-p2-task-04b`（指向 4f91671，工作区干净）
> 交付范围（用户已确认）：①一并实现 §10.4 剩余三端点 `/internal/jobs/start`、`/internal/jobs/:id/finish`、`/internal/health/source`；②运行前 approved 预检 = 新增 internal 资格端点（内部直接调 source-gate，批次端点仍兜底）
> 边界：不接任何真实数据源（04C）、不解析/落库观测明细（04E）、不动管理 UI（06C）、不启用定时采集工作流（04C 连续运行日）

## Why

collectors/ 目前只有占位包与合规 README；`/internal/*` 只有 04A 的 `ingest/batch`。04B 验收要求「不存在 arbitrary URL fetch；不能设置 approved 的连接器无法运行」，但当前既没有任何强制域名白名单/超时/限速/响应上限的 HTTP 层，也没有任何代码在采集开始**之前**判定来源资格（11.1-2「不是 approved 立即跳过并记录」），更没有任务开始/完成与来源健康的记录载体（§10.4 另三个端点缺位）。04C 首个数据源与 06C `/admin/jobs` 都以本框架为前置。

## What Changes

- **Private 迁移 0006 `jobs_health`**：`ingest_jobs`（job_id PK、source_id、city_code、status ∈ running/succeeded/failed CHECK、started_at、finished_at、error_code、note）+ `source_health_reports`（report_id PK、source_id、status ∈ ok/degraded/down CHECK、latency_ms、detail、checked_at，append-only）。不改 Public 库、不改 04A 既有表。
- **internal 端点扩三（共用 04A 签名链）**（[internal.ts](file:///e:/desktop/home_search/apps/api/src/routes/internal.ts)）：
  - 把 04A 的 时间戳→nonce→签名 校验链提取为共享中间件/函数（**不改变既有行为与错误码顺序**），新端点全部复用；
  - `POST /internal/jobs/start`（body：job_id、source_id、city_code）→ 门禁 `assertIngestAllowed` → INSERT ingest_jobs(running) → 202；同 job_id 重复 → 202 `duplicate`（幂等，不重复写）；
  - `POST /internal/jobs/:id/finish`（body：status ∈ succeeded/failed、可选 error_code/note）→ 更新 finished_at；job 不存在 → 404 `job_not_found`；已完成的 job 重复 finish → 幂等返回当前状态不改写；
  - `POST /internal/health/source`（body：source_id、status ∈ ok/degraded/down、可选 latency_ms、detail）→ **不设资格门禁**（健康上报反映的恰恰可能是来源不可用）→ INSERT source_health_reports → 202。
- **资格预检端点**：`POST /internal/sources/:id/eligibility`（body：可选 city_code/object_level，二者必须同给同缺）——source 不存在 → 404 `source_not_found`；仅 source_id 时执行 `resolveLicense`（含惰性过期），非 approved_* → 403 `source_not_approved`；带 coverage 时直接执行 `assertIngestAllowed`（超范围/城市未开通同 04A 错误码）；通过 → 200 `{eligible:true, source_id, status, valid_until}`。**判定完全来自 source-gate，端点内不写任何自有状态查询**（project_memory 红线：connector 复用 source-gate，不得自写查询）。
- **新错误码**：仅 `job_not_found`（404）。其余复用 04A 八码与通用码。
- **校验层**：[schemas.ts](file:///e:/desktop/home_search/apps/api/src/schemas.ts) 新增 `ingestJobStartSchema`、`ingestJobFinishSchema`、`sourceHealthSchema`、`sourceEligibilitySchema` 四 schema（均 additionalProperties:false）。
- **Python connector 框架**（`collectors/property_radar_collectors/`）：
  - `errors.py`：`ConnectorError` 基类 + 稳定错误码（`allowlist_violation`、`rate_limited`、`timeout_exceeded`、`retries_exhausted`、`response_too_large`、`http_status_error`、`parse_error`、`not_approved`、`internal_unavailable` 等），与 Worker 侧 error_code 语义对齐；
  - `allowlist.py`：静态域名白名单——每个 connector 声明 `ALLOWED_HOSTS`，`assert_url_allowed(url)` 在**任何网络 I/O 之前**执行，非白名单（含任意 URL、非 https、含凭据 URL）→ `allowlist_violation`；白名单只来自代码/配置常量，**不接受运行时传入的任意 URL 配置**；
  - `http.py`：安全 HTTP 层（基于 httpx）——连接/读取超时、有限重试+指数退避、最小请求间隔+并发上限的速率限制、流式读取**响应体字节上限**（超限中止）、仅 GET、状态码校验；日志脱敏：不记录请求头/Authorization/Cookie/令牌，错误消息中的 token/邮箱形态做掩码；
  - `schema.py`：`SourceRecord`（来源原始记录最小字段）与 `NormalizedObservation`（字段对齐 §9.1 price_observations：source_id、object_type、price_type、metric_code、price_total_fen、unit_price_yuan_sqm、area_sqm、sample_count、stat_date、quality_status、connector_version 等）dataclass + 校验/归一化函数（单位与日期形态校验，**不做任何数据库写入**——落库属 04E）；
  - `connector.py`：`SourceConnector` 抽象基类（§5.6 四方法：`health_check`、`fetch_region_data`、`fetch_community_data`、`normalize`）；无社区级授权的连接器 `fetch_community_data` 必须返回 `unsupported` 而非伪造数据；
  - `internal_client.py`：Worker internal API 的 HMAC-SHA256 签名客户端（`timestamp.nonce.rawBody` 小写 hex、±300s、随机 nonce，与 04A 服务端完全同口径），提供 `check_eligibility()`、`submit_batch()`、`job_start()`、`job_finish()`、`report_health()`；secret 只从环境变量 `INGEST_HMAC_SECRET` 读取，不入日志/异常；
  - `runner.py`：`run_guard()`——**运行前置门禁**：先 `check_eligibility()`（带 city_code/object_level），非 eligible 抛 `NotApprovedError`（`not_approved`），连接器在发出任何采集请求之前即终止（04B 验收的裁决点）。
- **fixture 测试**（`collectors/tests/`，pytest + httpx MockTransport，不打真实网络）：
  - allowlist：非白名单 URL/http/带凭据 → 拒绝且零网络调用；白名单放行；
  - http 层：超时、重试耗尽、4xx/5xx、响应体超上限中止、速率限制生效（计时断言）、日志无 Authorization/secret；
  - schema 归一化：正常样本→合法 NormalizedObservation；缺字段/极端价格/日期形态错→稳定错误；
  - connector 契约：`fetch_community_data` 未授权返回 unsupported；`health_check` 只访问白名单端点；
  - gate：eligibility 拒绝（mock 403 source_not_approved）→ `run_guard` 在零采集请求下抛 `not_approved`；eligibility 通过 → 放行；
  - 签名客户端：与已知向量对拍（同 ts/nonce/body → 同 hex），签名覆盖 body 篡改可见。
- **依赖与 CI**：`collectors/requirements.txt` 加 `httpx`（运行）+ `pytest`（测试），版本锁定；[ci.yml](file:///e:/desktop/home_search/.github/workflows/ci.yml) 新增独立 `collectors` job（actions/setup-python 固定 commit SHA、`pip install -r`、`pytest`），与既有 TS job 并行；不引入任何付费依赖（§12.0-9）。
- **文档**：collectors/README 更新结构与运行方式（`python -m pytest collectors/tests`）；`.env.example` 增列 `INGEST_HMAC_SECRET` 已存在（04A），Python 侧复用同一环境变量名，无新增 Secret。
- **BREAKING**：无（仅新增表、端点、错误码与 Python 包；`ingest/batch` 行为与错误码不变）。

## Impact

- Affected specs: 通用 Connector 框架（04B）、首个官方数据源（04C 消费 jobs/health/eligibility）、数据清洗落库（04E 消费 NormalizedObservation）、数据源管理后台（06C 消费 /admin/jobs 与 health 展示）
- Affected code:
  - `db/migrations/private/0006_jobs_health.{up,down}.sql`、`packages/migrations/src/index.test.ts`（PRIVATE_TABLES +2）
  - `apps/api/src/routes/internal.ts`（提取共享签名校验 + 三新端点 + eligibility）、`schemas.ts`、`errors.ts`（job_not_found）
  - `apps/api/src/routes/internal.test.ts` 扩展（或新增 `internal_jobs.test.ts`）
  - `collectors/`：`property_radar_collectors/{errors,allowlist,http,schema,connector,internal_client,runner}.py`、`tests/`、`requirements.txt`
  - `.github/workflows/ci.yml`（python job）、`collectors/README.md`
- 无需改动：`apps/web`、`source-gate.ts`（只被复用不修改）、`routes/admin.ts`、Public 迁移

## ADDED Requirements

### Requirement: 域名白名单先于一切网络 I/O

Python 连接器 SHALL 在发出任何网络请求之前执行静态域名白名单校验：URL 必须 https、无内嵌凭据、host 精确命中该连接器声明的 `ALLOWED_HOSTS`；白名单只来源于代码常量/仓库配置，SHALL NOT 支持运行时注入任意 URL 目标。违反 → `allowlist_violation` 且**零网络调用**。

#### Scenario: 任意 URL fetch 不存在

- **WHEN** 以 `https://evil.example.com/price` 或 `http://allowed-host.example/...` 调用安全 HTTP 层
- **THEN** 请求前即抛 `allowlist_violation`，MockTransport 记录的出站请求数为 0

### Requirement: 连接器运行前资格门禁

`run_guard()` SHALL 在连接器执行任何采集前调用 `POST /internal/sources/:id/eligibility`（携带 city_code/object_level）；响应 403（`source_not_approved`/`city_coverage_denied`）或 404 → 抛 `NotApprovedError`（`not_approved`）终止运行，不发出任何采集请求；仅 `eligible:true` 才放行。端点资格判定 SHALL 完全来自 `source-gate`（resolveLicense/assertIngestAllowed），Python 侧不直查数据库。批次提交时 `assertIngestAllowed` 兜底仍然生效。

#### Scenario: 未 approved 的连接器无法运行（04B 验收二）

- **WHEN** 来源状态为 pending_review 时调用 `run_guard()` 后尝试 `fetch_region_data()`
- **THEN** `run_guard` 抛 `not_approved`，采集出站请求数为 0，未调用 submit_batch

#### Scenario: 批次兜底仍生效

- **WHEN** 资格预检通过后、提交前来源被 suspend，连接器仍提交批次
- **THEN** `/internal/ingest/batch` 返回 403 `source_not_approved`（04A 既有行为不变）

### Requirement: HTTP 层安全约束

安全 HTTP 层 SHALL：只允许 GET；强制连接/读取超时（可配默认值）；有限重试 + 指数退避（仅对超时/5xx，重试耗尽 → `retries_exhausted`）；最小请求间隔与并发上限（违反内部节流 → `rate_limited`）；流式读取响应体超过字节数上限即中止 → `response_too_large`；非 2xx → `http_status_error`（不回显响应体中的敏感内容）。日志 SHALL NOT 记录任何请求头、Authorization/Cookie 值、令牌或完整响应体；错误消息中的 token/邮箱形态 SHALL 掩码。

#### Scenario: 响应体上限

- **WHEN** 模拟端点返回超过上限的字节数
- **THEN** 读取中止并抛 `response_too_large`，不把超限内容交给解析层

#### Scenario: 日志脱敏

- **WHEN** 请求携带 `Authorization: Bearer secret-token` 且发生 500 错误
- **THEN** 捕获的日志文本不含 `secret-token`，也不含 `INGEST_HMAC_SECRET` 的值

### Requirement: 归一化 Schema 与错误体系

`NormalizedObservation` 字段 SHALL 对齐 §9.1 `price_observations`（object_type/price_type/metric_code/price_total_fen/unit_price_yuan_sqm/area_sqm/sample_count/stat_date/quality_status/connector_version 等）；`normalize()` SHALL 校验单位与日期形态（YYYY-MM-DD）、拒绝缺失必填字段与负样本量 → 稳定错误码。Python 错误 SHALL 全部经 `ConnectorError` 子类携带稳定 `code`，不抛裸异常给任务调度层。原始 HTML/图片/个人信息 SHALL NOT 被保存（§5.7）。

#### Scenario: fixture 回归

- **WHEN** 对同一 fixture（正常样本、缺字段、极端价格、日期形态错）跑 `pytest`
- **THEN** 正常样本产出合法 NormalizedObservation，异常样本分别以稳定 code 失败，解析规则变化会立即被 fixture 测试捕获

### Requirement: 任务与健康记录端点

`POST /internal/jobs/start`、`POST /internal/jobs/:id/finish`、`POST /internal/health/source` SHALL 与 `ingest/batch` 使用同一 HMAC 签名/时间戳/nonce 校验链与 `ingest_disabled` 禁用语义。jobs/start SHALL 过 `assertIngestAllowed` 门禁（未 approved 来源连任务都起不来，与 11.1-2 一致）；jobs/:id/finish 更新 status/finished_at（未知 job → 404 `job_not_found`，重复 finish 幂等不改写）；health/source 直接记录（202），schema 校验 status ∈ ok/degraded/down。

#### Scenario: 未 approved 来源无法启动任务

- **WHEN** 对 pending_review 来源带合法签名调用 jobs/start
- **THEN** 403 `source_not_approved`，ingest_jobs 无新行

#### Scenario: 任务完成与健康记录

- **WHEN** 合法签名调用 jobs/start（approved 来源）→ jobs/:id/finish(status=failed, error_code=parse_error) → health/source(status=degraded)
- **THEN** 三步分别 202，ingest_jobs 该行 status=failed 且 finished_at 非空，source_health_reports 出现对应行

### Requirement: fixture 测试与 CI

collectors SHALL 提供 pytest 测试（httpx MockTransport，不出网），覆盖 allowlist/http/schema/connector 契约/gate/签名六类；CI SHALL 新增独立 Python job 安装 requirements 并跑 pytest，与 TS job 并行；四门禁（typecheck/lint/test/build）保持全绿。

#### Scenario: CI 跑 Python 测试

- **WHEN** push 触发 CI
- **THEN** collectors job 安装锁定依赖并执行 pytest 全绿；既有 quality job 不受影响
