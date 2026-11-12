# collectors（Python 采集与规范化）

## 合规红线（PRD §5.4/§5.6）

1. **未获书面授权前，本目录不包含任何针对贝壳/链家/安居客/房天下等平台的爬虫、脚本或逆向代码。**
2. 采集前必须核验：来源在 `config/sources/data-sources.json` 中状态为 `approved_open` / `approved_licensed`，且 §5.3 十项审批记录完整（审批人、证据链接、许可字段、保留期限、复核日期）。
3. 无存储授权时只存规范化字段，不存原始 HTML/图片/个人信息；联系方式字段不入库。
4. 连接器实现（源站变更提示、最小并发与超时、JSONL 原始备份、规范化入库）在取得授权后的对应城市任务中实施。

## 结构约定（TASK-04B 已落地）

```text
collectors/
  README.md                          # 本文件
  requirements.txt                   # 依赖清单（httpx + pytest，已锁版本）
  pytest.ini                         # pytest 配置（testpaths / pythonpath）
  property_radar_collectors/         # Python 包根
    __init__.py                      # 版本与模块出口
    errors.py                        # ConnectorError 稳定错误码 + 脱敏 redact()
    allowlist.py                     # 静态域名白名单（任何网络 I/O 之前强制）
    http.py                          # 安全 HTTP 层（GET/超时/重试/限速/响应上限/脱敏日志）
    schema.py                        # SourceRecord / NormalizedObservation 归一化
    connector.py                     # SourceConnector 统一接口 + SourceHealth
    internal_client.py               # Worker /internal HMAC 签名客户端（同服务端口径）
    runner.py                        # run_guard() 运行前置资格门禁（未 approved 不得运行）
  tests/                             # pytest fixture 测试（httpx MockTransport，不出网）
    fixtures/*.json                  # 归一化回归样本（正常/缺字段/极端价格/日期错）
    test_allowlist.py                # 验收一：不存在 arbitrary URL fetch
    test_http.py                     # HTTP 安全约束与日志脱敏
    test_schema.py                   # 归一化稳定性
    test_connector.py                # 连接器契约（无社区授权 → unsupported）
    test_gate.py                     # 验收二：run_guard 资格门禁
    test_internal_client.py          # HMAC 签名对拍与错误映射
  config/sources/                    # 来源配置（JSON 格式，含访问参数占位）
```

依赖安装：`python -m pip install -r collectors/requirements.txt`（当前仅框架层：httpx/pytest，
真实数据源连接器依赖在取得授权后的 04C 任务逐项追加）。

测试运行：`python -m pytest collectors/tests`（CI 独立 job `collectors` 每次 push 运行；
全测试不出网——HTTP 全部经 httpx MockTransport）。

## 运行门禁与密钥

- 连接器运行前必须经 `runner.run_guard()` 资格预检（调用服务端 `/internal/sources/:id/eligibility`，
  判定完全来自 source-gate）：来源未 `approved` 或超授权范围 → `NotApprovedError`（零采集请求）。
- `job_start` / `submit_batch` / `report_health` 走 `/api/v1/internal/*` HMAC 签名端点，
  签名口径 `HMAC-SHA256(INGEST_HMAC_SECRET, ts.nonce.body)` 小写 hex（与 `routes/internal.ts` 逐字节一致）。
- 密钥只从环境变量 `INGEST_HMAC_SECRET` 读取，绝不入日志、异常消息或仓库。
