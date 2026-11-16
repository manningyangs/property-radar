-- TASK-06D 回滚：删除 ingest_jobs.run_type 列
-- 幂等容错：覆盖「列已删（no such column）」与「表已随下游 down 删除（no such table）」
-- +migrate-idempotent: no such
ALTER TABLE ingest_jobs DROP COLUMN run_type;
