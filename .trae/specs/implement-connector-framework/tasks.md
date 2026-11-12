# Tasks

- [x] Task 1: 迁移与迁移测试（Private 0006）
  - [x] SubTask 1.1: `db/migrations/private/0006_jobs_health.up.sql`/`down.sql`——`ingest_jobs`（job_id PK、source_id、city_code、status CHECK running/succeeded/failed 默认 running、started_at 默认 now、finished_at、error_code、note）+ `source_health_reports`（report_id PK、source_id、status CHECK ok/degraded/down、latency_ms 可空、detail 可空、checked_at；append-only 无 UPDATE 路径）；IF NOT EXISTS/DROP IF EXISTS 幂等
  - [x] SubTask 1.2: `packages/migrations/src/index.test.ts`——PRIVATE_TABLES +2；断言 up 重复执行幂等、down 干净、status CHECK 生效（非法值报错）
- [x] Task 2: internal 端点共享签名校验提取 + 四新端点
  - [x] SubTask 2.1: 从 `internal.ts` 的 ingest/batch 提取共享签名链函数（时间戳→nonce 落库→HMAC 定长比较→错误码顺序完全不变，batch 行为回归测试不改）；`schemas.ts` 增 `ingestJobStartSchema`/`ingestJobFinishSchema`/`sourceHealthSchema`/`sourceEligibilitySchema`（additionalProperties:false）
  - [x] SubTask 2.2: `POST /internal/jobs/start`（门禁 assertIngestAllowed → INSERT running → 202；同 job_id → 202 duplicate 幂等）；`POST /internal/jobs/:id/finish`（status succeeded/failed + 可选 error_code/note → 更新 finished_at；未知 → 404 `job_not_found`；重复 finish 幂等返回当前状态）
  - [x] SubTask 2.3: `POST /health/source`（source_id/status(ok|degraded|down)/latency_ms/detail → INSERT 202，不设资格门禁）；`POST /sources/:id/eligibility`（仅 source_id → resolveLicense；带 city_code+object_level → assertIngestAllowed；通过 200 `{eligible:true,source_id,status,valid_until}`；失败透传 source-gate 错误码；二者必须同给同缺否则 400）
  - [x] SubTask 2.4: `errors.ts` 增 `job_not_found`(404)；核实端点挂载在既有 internalRoutes 前缀下
- [x] Task 3: API 测试（internal 扩展）
  - [x] SubTask 3.1: 签名链共享后 ingest/batch 既有测试全绿（行为无回归：四态 403 + 202/duplicate）
  - [x] SubTask 3.2: jobs——pending_review 起任务 403 无行；approved start 202 → finish 202（行 status/finished_at 正确）；未知 job finish 404 `job_not_found`；重复 start/duplicate、重复 finish 幂等
  - [x] SubTask 3.3: health——合法签名 202 落行、非法 status 400、缺签名 403；eligibility——未 approved 403、覆盖外 403 `city_coverage_denied`、未知 source 404、eligible:true 200 含 status/valid_until、缺 secret 403 `ingest_disabled`
- [x] Task 4: Python 框架核心（errors/allowlist/http/schema/connector）
  - [x] SubTask 4.1: `errors.py`（ConnectorError + 稳定 code：allowlist_violation/rate_limited/timeout_exceeded/retries_exhausted/response_too_large/http_status_error/parse_error/not_approved/internal_unavailable/validation_error）；`allowlist.py`（assert_url_allowed：https、无凭据、host 精确匹配 ALLOWED_HOSTS，违者零网络调用）
  - [x] SubTask 4.2: `http.py`（httpx：仅 GET、连接/读取超时、重试+指数退避仅超时/5xx、最小请求间隔+并发上限、流式响应体字节上限、非 2xx → http_status_error、日志脱敏不记头/令牌/响应体）
  - [x] SubTask 4.3: `schema.py`（SourceRecord、NormalizedObservation dataclass 对齐 §9.1 price_observations + 单位/日期形态/必填校验，无 DB 写入）；`connector.py`（SourceConnector ABC 四方法，fetch_community_data 无授权返回 unsupported 不伪造）
- [x] Task 5: internal 客户端与运行门禁（internal_client/runner）
  - [x] SubTask 5.1: `internal_client.py`——HMAC-SHA256(`${ts}.${nonce}.${rawBody}`) 小写 hex、随机 nonce、时间戳 unix 秒；secret 只读环境变量 `INGEST_HMAC_SECRET` 不入日志/异常；方法 check_eligibility/submit_batch/job_start/job_finish/report_health
  - [x] SubTask 5.2: `runner.py`——`run_guard()` 先 check_eligibility（含 city_code/object_level），403/404 → NotApprovedError(`not_approved`)，零采集请求终止；eligible:true 放行；`requirements.txt` 锁定 httpx+pytest
- [x] Task 6: fixture 测试（collectors/tests，pytest + MockTransport 不出网）
  - [x] SubTask 6.1: allowlist（任意 URL/http/带凭据 → 拒绝且 0 出站请求；白名单放行）+ http 层（超时、重试耗尽、4xx/5xx、响应体超上限、速率限制计时、日志无 Authorization/secret）
  - [x] SubTask 6.2: schema 归一化（正常样本合法、缺字段/极端价格/日期错 → 稳定 code）+ connector 契约（community 未授权 → unsupported、health_check 只打白名单）
  - [x] SubTask 6.3: gate（mock 403 source_not_approved → run_guard 抛 not_approved 且零采集请求；eligible 放行）+ 签名对拍（已知 ts/nonce/body → 已知 hex；body 篡改签名不匹配）
- [x] Task 7: CI 与文档
  - [x] SubTask 7.1: `ci.yml` 新增 `collectors` job（actions/setup-python 固定 commit SHA、pip install -r collectors/requirements.txt、python -m pytest collectors/tests），permissions 最小、与 quality job 并行
  - [x] SubTask 7.2: collectors/README 更新结构、依赖安装与测试命令；核对 `.env.example` 无多余密钥值
- [x] Task 8: 四门禁与验收
  - [x] SubTask 8.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿 + `python -m pytest collectors/tests` 全绿
  - [x] SubTask 8.2: 本地验收脚本（临时文件不入库）：起 wrangler dev 9600，串测 eligibility（approved/pending/超范围/未知）→ jobs start/finish（门禁、幂等、404）→ health 落行 → 既有 batch 四态 403 回归；浏览器回归（真实模式首页/登录/watch + 演示模式 4322）确认零回归
- [x] Task 9: 提交与 CI
  - [x] SubTask 9.1: 中文 commit `TASK-04B: …`（UTF-8 临时文件 `git commit -F`）→ push → 盯 CI 至绿（含新 collectors job 首跑）
  - [x] SubTask 9.2: §12.0 收尾报告（改动摘要/文件/测试/风险/回滚）→ checklist 勾选入库 → 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 1] 独立先行（Task 2 依赖新表）
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4] 独立（可与 Task 1/2/3 并行）
- [Task 5] depends on [Task 2, 4]（客户端口径对齐服务端签名链）
- [Task 6] depends on [Task 4, 5]
- [Task 7] depends on [Task 6]
- [Task 8] depends on [Task 3, 6]
- [Task 9] depends on [Task 8]
