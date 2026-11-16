-- TASK-06D：ingest_jobs 增 workflow_url 列（§8.6 采集工作流链接，可空）
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN workflow_url TEXT;
