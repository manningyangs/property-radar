-- TASK-06D 回滚：删除 ingest_jobs.records_rejected 列
-- +migrate-idempotent: no such
ALTER TABLE ingest_jobs DROP COLUMN records_rejected;
