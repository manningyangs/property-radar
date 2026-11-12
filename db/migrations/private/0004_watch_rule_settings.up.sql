-- TASK-03B：规则设置侧表（PRD 任务行 1266：有效期 + 通知偏好 + 触发状态/re-arm 所需扩展）
-- 不 ALTER watch_rules（SQLite ADD COLUMN 非幂等，与 0003 同策略用新表）：
--   - valid_until：规则有效期，YYYY-MM-DD，NULL=长期有效；
--   - notify_email/digest/inapp：每规则独立通知渠道开关（与用户级 notification_preferences 并存）；
--   - 规则/监控对象删除时按 FK 级联清理，杜绝孤儿行；
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS watch_rule_settings (
  rule_id      TEXT PRIMARY KEY REFERENCES watch_rules (rule_id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  valid_until  TEXT CHECK (valid_until IS NULL OR valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  notify_email INTEGER NOT NULL DEFAULT 1 CHECK (notify_email IN (0, 1)),
  notify_digest INTEGER NOT NULL DEFAULT 1 CHECK (notify_digest IN (0, 1)),
  notify_inapp INTEGER NOT NULL DEFAULT 1 CHECK (notify_inapp IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
