# Data Cleaning & Quality Checklist

- [x] 缺字段（缺 stat_date / 双价皆空 / area_sqm≤0 / 指数缺 index_value）被 400 拒绝且 details 指回字段
- [x] 指数互斥：official_index 禁金额字段、价格类观测禁 index_value，两端（TS schema + Python schema）阈值同源
- [x] 极端价格阈值（单价 10 万/㎡、总价 1000 万/套）拒绝且不落库（拍板 1：仅 details 留痕）
- [x] 未来日期（Asia/Shanghai 当日界）拒绝；stat_date 早于当前最新值仍入历史、新快照与 prices 首条不回拨
- [x] 批内去重：落库 1 行、duplicates_dropped=1；跨批同 payload_hash 行数不变
- [x] 样本分层：<5 → low_sample（median 仍算）、≥5 → valid，快照 quality_status 与 prices items 一致
- [x] 过期物化：STALE_AFTER_DAYS 默认 30 天、official_index 92 天；stale 不聚快照（snapshots_upserted=0）
- [x] METHOD_VERSION=04e-aggregate-v2 快照落列，prices 返回 method_version，分位数/阈值口径唯一真源注释
- [x] 迁移 0004 index_value 列 + schemas/observations 扩展；canonical JSON 仅 index_value 非空含键（ID 稳定测试）
- [x] 指数 ×4 落库：run_daily 携带 observations 明细，_yoy/_mom × 新建/二手均可见
- [x] 异常留痕：拒绝仅计数（duplicates_dropped/observed_count + 400 details），原始行不写 rejected_* / 脏行/错行不落库
- [x] 六类清洗 fixture 测试逐行断言（规则→构造→期望→实测全绿）
- [x] 原始 HTML 不入持久层（SourceRecord/NormalizedObservation/ingest 载荷/异常消息零页面内容，哨兵测试锁死）
- [x] `pnpm typecheck` / `lint` / `test` / `-r build` 全绿 + `py -3 -m pytest collectors/tests` 全绿
- [x] 本地 wrangler dev 18789 e2e（六类直发 6/6 + 指数双口径 8 行 + method_version + 浏览器零回归）
- [x] 生产部署与 e2e（db:apply 0004 + deploy + 回放幂等复跑零新增 + 过期/极端冒烟 + prices method_version）
- [x] `docs/TASK-04E-数据清洗与质量管理验收报告.md`（六类结果表 / 口径版本说明 / 指数双口径证据）
