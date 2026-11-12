# Checklist

## 数据与迁移

- [x] Private 0006 `ingest_jobs`/`source_health_reports`，up 重复幂等、down 干净；PRIVATE_TABLES +2
- [x] status CHECK 生效（jobs: running/succeeded/failed；health: ok/degraded/down）
- [x] 不改 Public 库、不改 04A 表结构与 `ingest/batch` 行为

## internal 端点（签名链复用）

- [x] 签名校验提取为共享实现，错误码顺序不变；ingest/batch 既有测试全绿（四态 403 + accepted/duplicate 202）
- [x] jobs/start：未 approved 来源 → 403 `source_not_approved` 且无行；approved → 202 running；同 job_id 重复 → 202 duplicate 幂等
- [x] jobs/:id/finish：未知 → 404 `job_not_found`；正常更新 status/finished_at；重复 finish 幂等不改写
- [x] health/source：合法签名 202 落行；schema 拒绝非法 status；**不设资格门禁**（健康可上报 down）
- [x] sources/:id/eligibility：完全走 source-gate——未知 404、未 approved 403、覆盖外/城市未开通 403 `city_coverage_denied`、通过 200 `{eligible:true,...}`；city_code/object_level 同给同缺；缺 secret 403 `ingest_disabled`

## Python 框架

- [x] **验收一：不存在 arbitrary URL fetch**——非白名单/非 https/带凭据 URL 在任何网络 I/O 前抛 `allowlist_violation`，出站请求数 0；白名单仅来自代码/配置常量，无运行时任意目标注入
- [x] **验收二：不能设置 approved 的连接器无法运行**——`run_guard()` 资格预检 403/404 → `NotApprovedError(not_approved)`，零采集请求、未提交批次；批次端点兜底仍生效
- [x] HTTP 层：仅 GET、超时、有限重试+指数退避、请求间隔与并发上限、响应体字节上限中止、非 2xx 稳定错误
- [x] 日志脱敏：不记录请求头/Authorization/Cookie/令牌/完整响应体；错误消息中 token、邮箱形态掩码；`INGEST_HMAC_SECRET` 值不入日志与异常
- [x] `NormalizedObservation` 对齐 §9.1 price_observations；单位/日期形态/必填校验；无任何 DB 写入
- [x] `SourceConnector` 四方法契约；无社区授权 → `fetch_community_data` 返回 unsupported 不伪造；不保存原始 HTML/图片/个人信息（§5.7）
- [x] 所有 Python 异常经 `ConnectorError` 携带稳定 code

## 测试与 CI

- [x] pytest 全绿且不出网（httpx MockTransport）：allowlist/http/schema/connector 契约/gate/签名对拍 六类齐全
- [x] CI 新增 collectors job（setup-python 固定 commit SHA、pip install -r、pytest），permissions 最小，与 quality job 并行；CI 全绿
- [x] 四门禁全绿：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build`
- [x] 本地验收脚本全过（eligibility/jobs/health/batch 回归）；浏览器回归（真实模式 + 演示模式 4322）零回归

## 合规与流程

- [x] 无真实数据源接入、无爬虫代码、无定时采集工作流启用（04C 边界）；无付费依赖新增（§12.0-9）
- [x] 仓库/产物/日志无真实 Token、secret、邮箱；`.env.example` 仅环境变量名
- [x] 中文 commit `TASK-04B: …` → push → CI 绿（含 collectors job）；备份 tag `pre-v1-p2-task-04b` 存在
- [x] §12.0 收尾报告输出，checklist 勾选入库，记忆 topics.md / project_memory.md 更新
