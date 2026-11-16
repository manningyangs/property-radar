-- TASK-06D：ingest_jobs 增 records_fetched 列（§8.6 抓取记录数，可空）
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN records_fetched INTEGER;
