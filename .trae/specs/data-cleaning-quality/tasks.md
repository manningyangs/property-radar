# Tasks

- [x] Task 0: 流程启动
  - [x] SubTask 0.1: 读 PRD 任务行 1312–1318 与关联章节；4 项范围决策拍板（异常留痕=仅计数不落库、stale=写入时物化、日期倒退=未来拒绝旧入历史、环比双口径纳入）
  - [x] SubTask 0.2: 打 tag `pre-v1-p2-task-04e`；写 spec.md / tasks.md / checklist.md 并获批
- [x] Task 1: 清洗规则模块（服务端唯一实现点）
  - [x] SubTask 1.1: `apps/api/src/cleaning.ts`——纯函数 `cleanObservations(observations, now)`：缺字段/指数互斥语义、极端价格阈值（10 万/㎡、1000 万/套）、未来日期（Asia/Shanghai 当日）、过期物化（STALE_AFTER_DAYS：official_index=92、默认=30 → quality_status='stale'）、批内按 observation_id 去重（duplicates_dropped）
  - [x] SubTask 1.2: 接入 `POST /internal/ingest/batch` 与 `POST /admin/observations`（先于任何 DB 写；400 时零行）；口径常量（MIN_VALID_SAMPLES/STALE_AFTER_DAYS/极端阈值）集中导出为唯一真源
  - [x] SubTask 1.3: vitest——语义/极端/未来日期 400 + details + DB 零行、批内去重计数、过期观测落 stale 且 snapshots_upserted=0、既有门禁/签名/幂等回归全绿
- [x] Task 2: 指数落库迁移与口径版本化
  - [x] SubTask 2.1: `db/migrations/public/0004_index_value.up.sql` + `down.sql`——`price_observations` 增 `index_value REAL NULL`（CHECK 可行则附）；本地与远端 db:apply 幂等验证
  - [x] SubTask 2.2: `schemas.ts OBSERVATION_ITEM` 增 `index_value`（0<v≤1000）；`observations.ts` INSERT 增列 + canonical **仅 index_value 非空时含该键**（既有价格观测 payload_hash/observation_id 稳定，测试断言）；official_index 不聚快照注释
  - [x] SubTask 2.3: `METHOD_VERSION` 升 `04e-aggregate-v2` 并集中导出；`GET /public/communities/:id/prices` 快照对象补 `method_version` 字段 + 测试
- [x] Task 3: Python 环比双口径（04C 移交）
  - [x] SubTask 3.1: `qingdao_index.py index_observations()` 每期 ×4（yoy+mom × 新建/二手），mom metric_code = `new_house_price_index_mom` / `second_hand_price_index_mom`；头注释同步
  - [x] SubTask 3.2: `run_daily.py` submit_batch 携带 observations 明细（observed_count 一致性不变）；test_run_daily 载荷断言更新
- [x] Task 4: 六类清洗 fixture 与原始 HTML 强制测试
  - [x] SubTask 4.1: `apps/api/src/cleaning.test.ts`——重复/缺字段/极端价格/日期倒退/样本不足/过期 六组 fixture 逐行断言（spec §2 R4 表）
  - [x] SubTask 4.2: pytest——指数互斥与环比 bounds、双口径 4 条、拒绝计数入 note、HTML 哨兵测试（fang + qingdao_index：SourceRecord/载荷/异常消息零页面内容）、既有 96 项回归
- [x] Task 5: 四门禁与本地验收
  - [x] SubTask 5.1: `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 全绿 + `py -3 -m pytest collectors/tests` 全绿
  - [x] SubTask 5.2: 本地 wrangler dev 18789——六类规则 e2e（回放/直发各 fixture 断言响应与 DB 行）、指数双口径落库（run_daily fixture 回放 → price_observations 可见 _yoy/_mom 四类行）、prices 返回 method_version、浏览器零回归
- [x] Task 6: 生产部署与 e2e
  - [x] SubTask 6.1: 远端 db:apply 0004 + `wrangler deploy`
  - [x] SubTask 6.2: 生产 e2e——run_daily fixture 回放落指数观测（幂等复跑不变）、过期/极端 400 冒烟、prices method_version 冒烟
- [ ] Task 7: 验收报告与收尾
  - [x] SubTask 7.1: `docs/TASK-04E-数据清洗与质量管理验收报告.md`——六类 fixture 结果表（规则→构造→期望→实测）、口径版本说明（04e-aggregate-v2、阈值、分位数方法）、指数双口径落库证据
  - [ ] SubTask 7.2: 中文 commit `TASK-04E: …`（UTF-8 `git commit -F`）→ push → 盯 CI 绿
  - [ ] SubTask 7.3: §12.0 收尾报告 → checklist 勾选入库 → 更新记忆 topics.md / project_memory.md

# Task Dependencies

- [Task 0] 获批后方可开工
- [Task 1] 独立先行（Task 2 的 schema 语义与之同源）
- [Task 2] depends on [Task 1]（index 互斥校验在清洗模块）
- [Task 3] depends on [Task 2]（载荷带 index_value 需 schema 与列先就位）
- [Task 4] depends on [Task 1, 2, 3]
- [Task 5] depends on [Task 1–4]
- [Task 6] depends on [Task 5]
- [Task 7] depends on [Task 5, 6]
