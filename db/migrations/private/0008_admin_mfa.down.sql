-- TASK-06A 回滚：删除管理员 MFA 两表（子表先于 users/sessions，无跨表顾虑）
DROP INDEX IF EXISTS ix_admin_mfa_sessions_user;
DROP TABLE IF EXISTS admin_mfa_sessions;
DROP TABLE IF EXISTS admin_mfa_secrets;
