-- TASK-06D 回滚：删除 ingest_jobs.connector_version 列
-- +migrate-idempotent: no such
ALTER TABLE ingest_jobs DROP COLUMN connector_version;
