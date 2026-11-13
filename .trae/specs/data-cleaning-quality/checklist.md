# Checklist

## 六类清洗 fixture（PRD 验收：结果全部符合规则）

- [ ] 重复：批内同观测 ×2 → 落库 1 行 + duplicates_dropped=1；跨批同 payload 重提行数不变、payload_hash 稳定（幂等）
- [ ] 缺字段：缺 stat_date / 双价皆空 / area≤0 / 指数无 index_value → 400 字段级 details，DB 零行
- [ ] 极端价格：单价 >10 万/㎡、总价 >1000 万 → 400 details 不落库（拍板 1：仅计数留痕），Python 端拒绝计数入任务 note
- [ ] 统计日期倒退：先提新 stat_date 再提旧 → 旧入历史行、最新快照/ prices 首条仍为新日期；未来日期 → 400（Asia/Shanghai 当日为界）
- [ ] 样本不足：4 套 → 快照 low_sample（median 仍算留痕）；补足 5 套 → valid
- [ ] 过期数据：stat_date 超阈值 → 观测行 quality_status='stale'（写入时物化）、snapshots_upserted=0 不造数；阈值内对照组正常

## PRD 04E 要求逐条

- [ ] 面积单位/价格单位统一：Python 换算与服务端范围/互斥校验同阈值同源（单一常量导出）
- [ ] 异常数据留痕：400 details + 任务 note 计数可查（不落 rejected 行、不加原因列——拍板 1）
- [ ] 同源去重：确定性 observation_id 跨批幂等 + 批内去重计数
- [ ] 统计口径版本化：口径常量集中唯一真源；METHOD_VERSION 升 `04e-aggregate-v2`；公开 prices 返回 method_version
- [ ] 小样本降级：MIN_VALID_SAMPLES=5 收归清洗模块；快照 quality 分层正确
- [ ] 原始 HTML 默认不存：fixture 哨兵串测试（fang + qingdao_index 的 SourceRecord/载荷/异常消息零页面内容）

## 04C 移交：官方指数环比双口径落库

- [ ] 迁移 `public/0004_index_value`（up+down）本地与远端幂等应用
- [ ] `index_observations()` 每期 ×4（新建/二手 × yoy/mom），mom metric_code 后缀 `_mom`，既有 yoy code 不改名
- [ ] canonical JSON 仅 index_value 非空含键——既有价格观测 observation_id 稳定（测试断言），生产复跑不重复
- [ ] `run_daily` 携带 observations 明细提交，observed_count 一致；official_index 观测不聚快照（注释写明）
- [ ] 指数互斥语义：official_index 禁金额字段、价格类禁 index_value（服务端与 Python 同口径）

## 回归（04A/04B/04C/04D 零回归）

- [ ] 签名链/时间戳/nonce/批次 duplicate 202/run_guard 未 approved 零出网 照旧
- [ ] 既有 vitest 全绿 + pytest 96 项回归全绿
- [ ] coverage 六字段、prices collected_at、admin 补录审计照旧

## 验收与流程（PRD 验收 + §12.0）

- [ ] 四门禁全绿：`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` + `py -3 -m pytest collectors/tests`
- [ ] 本地 e2e：wrangler dev 18789——六类规则响应与 DB 行逐条断言、指数双口径回放落库、prices 含 method_version、浏览器零回归
- [ ] 生产：db:apply 0004 + deploy + 生产 e2e（指数回放幂等、过期/极端 400 冒烟、method_version 冒烟）
- [ ] `docs/TASK-04E-数据清洗与质量管理验收报告.md`：六类 fixture 结果表（规则→构造→期望→实测）+ 口径版本说明 + 指数落库证据
- [ ] 无付费依赖新增；仓库/日志无密钥、无原始页面全文、无个人信息
- [ ] 中文 commit `TASK-04E: …` → push → CI 绿；备份 tag `pre-v1-p2-task-04e` 存在
- [ ] §12.0 收尾报告输出，checklist 勾选入库，记忆 topics.md / project_memory.md 更新
