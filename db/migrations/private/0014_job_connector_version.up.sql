-- TASK-06D：ingest_jobs 增 connector_version 列（§8.6 连接器版本——异常定位链一环，可空）
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN connector_version TEXT;
