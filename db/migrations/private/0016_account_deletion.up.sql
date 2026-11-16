-- TASK-07B：注销冷静期（spec 2.1）——users 增加 deletion_requested_at，
-- status='deletion_pending' 时记录申请时间；到期 7 天后由 cron 硬删个人数据。
-- 幂等（02A「迁移可重复运行」不变量）：SQLite 无 ADD COLUMN IF NOT EXISTS，
-- +migrate-idempotent 指令在列已存在时按错误串容错；本文件保持单语句。
-- +migrate-idempotent: duplicate column name
ALTER TABLE users ADD COLUMN deletion_requested_at TEXT;
