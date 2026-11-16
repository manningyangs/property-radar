-- TASK-06D：观测批次归属查询索引（质量中心按 batch 定位观测）
CREATE INDEX IF NOT EXISTS ix_price_obs_batch
  ON price_observations (batch_id);
