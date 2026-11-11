-- TASK-02A：Private D1 回滚（等效重建流程的前半段）——幂等，可重复运行。
-- 顺序按外键依赖倒序；DROP TABLE 自动移除其上索引与唯一约束。

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS admin_roles;
DROP TABLE IF EXISTS user_consents;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_preferences;
DROP TABLE IF EXISTS alert_events;
DROP TABLE IF EXISTS watch_rules;
DROP TABLE IF EXISTS watch_items;
DROP TABLE IF EXISTS user_cities;
DROP TABLE IF EXISTS city_coverage_requests;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS email_otps;
DROP TABLE IF EXISTS users;
