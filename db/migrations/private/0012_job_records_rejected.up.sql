-- TASK-06D：ingest_jobs 增 records_rejected 列（§8.6 清洗拒绝数，可空）
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN records_rejected INTEGER;
