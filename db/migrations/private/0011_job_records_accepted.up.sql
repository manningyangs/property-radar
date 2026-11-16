-- TASK-06D：ingest_jobs 增 records_accepted 列（§8.6 入库记录数，可空）
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN records_accepted INTEGER;
