-- TASK-02C：回滚邮件配额账本（幂等）
DROP INDEX IF EXISTS ix_email_send_ledger_created;
DROP TABLE IF EXISTS email_send_ledger;
