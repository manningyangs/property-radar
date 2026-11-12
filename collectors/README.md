# collectors（Python 采集与规范化）

## 合规红线（PRD §5.4/§5.6）

1. **未获书面授权前，本目录不包含任何针对贝壳/链家/安居客/房天下等平台的爬虫、脚本或逆向代码。**
2. 采集前必须核验：来源在 `config/sources/data-sources.json` 中状态为 `approved_open` / `approved_licensed`，且 §5.3 十项审批记录完整（审批人、证据链接、许可字段、保留期限、复核日期）。
3. 无存储授权时只存规范化字段，不存原始 HTML/图片/个人信息；联系方式字段不入库。
4. 连接器实现（源站变更提示、最小并发与超时、JSONL 原始备份、规范化入库）在取得授权后的对应城市任务中实施。

## 首个官方数据源（TASK-04C：青岛市统计局住宅价格指数）

- 来源 `qd_stats_price_index`：青岛市统计局栏目页（月度住宅销售价格指数，市级 370200）。
  对接前完成开放许可/字段/区域/频率/口径核验，见 `docs/TASK-04C-青岛市统计局住宅价格指数核验报告.md`；
  许可状态 `approved_open`（种子 `db/seeds/0001_qingdao_official_index.sql`）。
- **http 例外**：该站全站 http（https 证书主机名不匹配）。例外通过连接器静态类属性
  `allowed_insecure_hosts`（`allowed_hosts` 子集）显式声明，白名单校验仍发生在一切网络 I/O 之前，
  其余主机/端口/scheme 一律 fail closed（见 `test_allowlist.py` 04C 用例）。
- **口径**：每期详情页四值（新建/二手 × 同比/环比）；归一化观测每期 ×2 指标，
  `index_value` 取同比列（本月，上年同月=100），`stat_date`=报告月月末，`sample_count`=0（不造数）；
  环比列保留在 `SourceRecord.fields` 供 04E 落库映射。指数不是金额（`official_index` 禁价格字段）。
- 解析器：`qingdao_index.py`（`parse_list_page` / `parse_detail_page` / `index_observations` /
  `QdStatsIndexConnector`）。无社区级授权 → `fetch_community_data` 返回 `unsupported`，不伪造。

## 结构约定（TASK-04B 落地 + TASK-04C 扩展）

```text
collectors/
  README.md                          # 本文件
  requirements.txt                   # 依赖清单（httpx + pytest + tzdata，已锁版本）
  pytest.ini                         # pytest 配置（testpaths / pythonpath）
  property_radar_collectors/         # Python 包根
    __init__.py                      # 版本与模块出口
    errors.py                        # ConnectorError 稳定错误码 + 脱敏 redact()
    allowlist.py                     # 静态域名白名单（任何网络 I/O 之前强制）
    http.py                          # 安全 HTTP 层（GET/超时/重试/限速/响应上限/脱敏日志）
    schema.py                        # SourceRecord / NormalizedObservation 归一化（含 official_index）
    connector.py                     # SourceConnector 统一接口 + SourceHealth + http 例外声明位
    internal_client.py               # Worker /internal HMAC 签名客户端（同服务端口径）
    runner.py                        # run_guard() 运行前置资格门禁（未 approved 不得运行）
    qingdao_index.py                 # 04C：青岛市统计局住宅价格指数连接器（首个官方源）
    run_daily.py                     # 04C：每日运行 CLI（门禁→健康→任务→批次→完成）
  tests/                             # pytest fixture 测试（httpx MockTransport，不出网）
    fixtures/*.json                  # 归一化回归样本（正常/缺字段/极端价格/日期错）
    fixtures/*.shtml                 # 04C：结构复刻合成页（列表 + 两期详情，非真实原文 §5.7）
    test_allowlist.py                # 验收一：不存在 arbitrary URL fetch（含 http 例外）
    test_http.py                     # HTTP 安全约束与日志脱敏
    test_schema.py                   # 归一化稳定性（含 official_index 口径）
    test_connector.py                # 连接器契约（无社区授权 → unsupported）
    test_gate.py                     # 验收二：run_guard 资格门禁
    test_internal_client.py          # HMAC 签名对拍与错误映射
    test_qingdao_index.py            # 04C：解析/样例四值/范围红线/健康状态
    test_run_daily.py                # 04C：全链顺序与签名/失败路径 job_finish(failed)
  config/sources/                    # 来源配置（JSON 格式，含访问参数占位）
```

依赖安装：`python -m pip install -r collectors/requirements.txt`
（httpx/pytest 框架层 + 04C 追加 tzdata——Windows 无系统时区库，`zoneinfo("Asia/Shanghai")` 需要）。

测试运行：`python -m pytest collectors/tests`（CI 独立 job `collectors` 每次 push 运行；
全测试不出网——HTTP 全部经 httpx MockTransport）。

### 每日运行（run_daily）

```bash
# 真实运行（环境变量 API_BASE + INGEST_HMAC_SECRET）
python -m property_radar_collectors.run_daily --run-date 2026-11-12

# 离线回放（fixture 零出网；--api-base 或 API_BASE 仍必填）
python -m property_radar_collectors.run_daily --fixture tests/fixtures --run-date 2026-11-05
```

流程：`run_guard` 资格预检（未 approved → 零采集，exit 1）→ `health_check`+上报 → `jobs/start`
→ 采集 45 天窗口内新发布期次 → 归一化（每期 ×2）→ `ingest/batch`（`observed_count`）→
`jobs/finish(succeeded|failed)`。缺 API 配置/日期非法 → exit 2；采集失败也尽力落
`jobs/finish(failed, error_code)`。输出经 `redact()` 脱敏。

## 运行门禁与密钥

- 连接器运行前必须经 `runner.run_guard()` 资格预检（调用服务端 `/internal/sources/:id/eligibility`，
  判定完全来自 source-gate）：来源未 `approved` 或超授权范围 → `NotApprovedError`（零采集请求）。
- `job_start` / `submit_batch` / `report_health` 走 `/api/v1/internal/*` HMAC 签名端点，
  签名口径 `HMAC-SHA256(INGEST_HMAC_SECRET, ts.nonce.body)` 小写 hex（与 `routes/internal.ts` 逐字节一致）。
- 密钥只从环境变量 `INGEST_HMAC_SECRET` 读取，绝不入日志、异常消息或仓库。
