-- TASK-06D：price_observations 增批次归属列（PRD 任务行 1368–1374 验收一：每一异常可定位 batch）
--   0001 建表时无 batch_id——观测与 ingest_batches 仅能靠时间窗弱关联。本列由 internal
--   批次受理时写入（admin 手工补录为 NULL）。
--   注意：canonicalObservation 不含 batch_id——observation_id 确定性口径不变（04D 幂等延续），
--   重跑同观测仅更新 batch_id/collected_at，不产生重复行。
-- 幂等（02A 不变量）：+migrate-idempotent 指令容错「列已存在」；本文件保持单语句，
--   配套索引见 0006_obs_batch_index（IF NOT EXISTS 天然幂等）。
-- +migrate-idempotent: duplicate column name
ALTER TABLE price_observations ADD COLUMN batch_id TEXT;
