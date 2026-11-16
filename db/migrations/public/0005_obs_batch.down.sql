-- TASK-06D 回滚：删除观测批次归属列（索引由 0006_obs_batch_index.down 先行删除）
-- 幂等容错：覆盖「列已删（no such column）」与「表已随 0001.down 删除（no such table）」
-- +migrate-idempotent: no such
ALTER TABLE price_observations DROP COLUMN batch_id;
