-- TASK-04E：price_observations 增指数值列（spec R3；PRD 任务行 1319–1324 / §4.5 双口径落库）
-- 列口径：REAL NULL——仅 price_type='official_index' 的观测携带（0 < v ≤ 1000）；CHECK 与应用层
-- OBSERVATION_ITEM_SCHEMA（exclusiveMinimum 0 / maximum 1000）及 cleaning 指数互斥校验同源。
-- 既有价格观测行全为 NULL，天然通过 CHECK；价格类观测携带 index_value 由服务端语义清洗拒绝。
-- 幂等（02A「迁移可重复运行」不变量）：SQLite 无「ADD COLUMN IF NOT EXISTS」，文件头
-- +migrate-idempotent 指令让迁移加载器在列已存在时按错误串容错——不重建表、数据零丢失；
-- 本文件保持单语句，容错仅覆盖该 ALTER 自身。
-- +migrate-idempotent: duplicate column name
ALTER TABLE price_observations
  ADD COLUMN index_value REAL
  CHECK (index_value IS NULL OR (index_value > 0 AND index_value <= 1000));
