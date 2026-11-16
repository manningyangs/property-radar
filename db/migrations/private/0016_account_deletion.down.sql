-- TASK-07B 回滚：删除 deletion_requested_at 列。
-- 幂等容错：覆盖「列已删（no such column）」与「表已随 0001.down 删除（no such table）」
-- 两种重复执行场景（同 public 0004 先例，单子串即可）。
-- +migrate-idempotent: no such
ALTER TABLE users DROP COLUMN deletion_requested_at;
