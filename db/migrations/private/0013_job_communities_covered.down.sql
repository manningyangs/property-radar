-- TASK-06D 回滚：删除 ingest_jobs.communities_covered 列
-- +migrate-idempotent: no such
ALTER TABLE ingest_jobs DROP COLUMN communities_covered;
