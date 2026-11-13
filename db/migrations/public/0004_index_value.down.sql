-- TASK-04E：回滚 0004——删除 index_value 列（列值随删，重跑 up 重建 NULL 列后由每日采集回填）。
-- 幂等容错：覆盖「列已删（no such column）」与「表已随 0001.down 删除（no such table）」两种重复执行。
-- +migrate-idempotent: no such
ALTER TABLE price_observations DROP COLUMN index_value;
