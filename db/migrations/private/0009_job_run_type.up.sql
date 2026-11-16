-- TASK-06D：ingest_jobs 增 run_type 列（§8.6 任务执行类型：scheduled/manual/retry，可空向后兼容）
-- 幂等（02A「迁移可重复运行」不变量）：SQLite 无 ADD COLUMN IF NOT EXISTS，
-- +migrate-idempotent 指令让加载器在列已存在时按错误串容错；本文件保持单语句。
-- +migrate-idempotent: duplicate column name
ALTER TABLE ingest_jobs ADD COLUMN run_type TEXT;
