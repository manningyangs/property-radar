# Checklist

## 核验与登记（PRD 要求）

- [x] 核验报告五要素齐全：开放许可、数据字段、区域范围、更新频率、统计口径
- [x] 对接前手工样例核对有原始记录（2026-09 期：新建 99.1/100.2、二手 95.0/99.9、发布 2026-11-03、来源注记），连接器解析结果与之一致
- [x] http-only 与 TLS 证书失效事实记录在案，风险说明与静态例外范围明确
- [x] `data-sources.json` 登记册与核验结论同步（verified_at/notes/局限）

## 字段验证（验收②）

- [x] Public 0003 `source_field_verifications` 幂等、down 干净；迁移测试更新（PUBLIC_TABLES +1、状态 CHECK 生效）
- [x] `GET /public/methodology/sources` 附 `field_verifications` + `verified_metrics`；**verified_metrics 仅由 status=verified 推导**，unverified 字段（base_index/district_level_index/transaction_price）不计入且 status 原样返回（API 测试断言）
- [x] 种子写入 6 条 verified + 3 条 unverified 字段行，evidence 指向样例核对值
- [x] 核验报告/登记册/公开 data_scope 均不把未验证字段表述为已验证

## 连接器与运行（PRD 要求 + 04B 两验收回归）

- [x] allowlist http 例外仅限代码常量显式声明的白名单主机（http 白名单外/空白名单/凭据/非默认端口仍零出站拒绝）；pytest 覆盖
- [x] official_index 归一化：index_value 必填(0<v<1000)、禁金额字段、stat_date 报告月月末、sample_count 可 0；非指数路径禁 index_value；原价格护栏回归（pytest）
- [x] `QdStatsIndexConnector`：health/列表+详情解析/date_range 过滤/超范围 region 拒绝/community 返回 unsupported；不落原始 HTML
- [x] `run_daily` 全链：run_guard 先于一切采集请求 → health → jobs start/finish → batch(observed_count) → 失败尽力记 failed 且非零退出；密钥只读 env、日志无敏感
- [x] pytest 全绿且不出网（fixture/MockTransport）——81 passed

## 7 运行日（验收①）

- [x] 本地回放 7 个 run-date（2026-11-05~2026-11-11，fixture 零出网）→ 本地 `ingest_jobs` 7 行 status=succeeded、job/batch 各 7 条、错误码为空；证据入收尾报告
- [ ] 生产每日 schedule（06:10 北京）已上线，真实日历日累计口径在报告中与回放口径明确区分

## 部署与定时任务

- [x] 远端迁移补齐（public 0001–0003、private 0001–0006）且幂等可重放；种子在本地与远端同文件应用成功
- [x] 生产 Worker 已部署；`INGEST_HMAC_SECRET` 仅存 Wrangler/GitHub Secrets，仓库与日志无值；`db:apply:*` 脚本补全
- [x] GitHub Secrets `API_BASE`/`INGEST_HMAC_SECRET` 配置完成；daily workflow（固定 SHA、最小 permissions、prettier 过）
- [ ] `workflow_dispatch` 真跑：真实访问青岛市统计局站点 + 生产 API 记录第 1 个真实运行日；失败则如实入报告不伪造

## 门禁、验收与流程

- [x] 四门禁全绿：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build`
- [x] 生产冒烟：eligibility 200 / jobs start+finish 202 / batch 202 / methodology 含 field_verifications
- [x] 浏览器回归（真实模式 + 演示 4322）零回归——6/6 PASS
- [x] 无真实数据源违规接入（仅官方开放许可源）、无爬虫绕过、无付费依赖新增；仓库/日志无密钥与真实个人邮箱
- [ ] 中文 commit `TASK-04C: …` → push → CI 绿；备份 tag `pre-v1-p2-task-04c` 存在
- [ ] §12.0 收尾报告输出，checklist 勾选入库，记忆 topics.md / project_memory.md 更新
