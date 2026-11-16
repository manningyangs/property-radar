-- TASK-06D 回滚：删除 ingest_jobs.workflow_url 列
-- +migrate-idempotent: no such
ALTER TABLE ingest_jobs DROP COLUMN workflow_url;
