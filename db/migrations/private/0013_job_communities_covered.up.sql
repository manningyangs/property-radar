-- TASK-06D：ingest_jobs 增 communities_covered 列（§8.6 本次覆盖小区数，可空）
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN communities_covered INTEGER;
