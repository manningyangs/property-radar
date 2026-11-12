-- TASK-03A：监控对象分组（PRD §2.7 监控列表 / §9.2 数据模型补充）
-- 每个监控对象最多归属一个分组（watch_id 主键保证 1:1）；
-- 分组名 1–50 字符（与 API JSON Schema 校验一致，SQLite length 按字符计）；
-- 幂等（IF NOT EXISTS），不 ALTER 旧表，迁移可重复运行。
CREATE TABLE IF NOT EXISTS watch_item_groups (
  watch_id    TEXT PRIMARY KEY REFERENCES watch_items (watch_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  group_name  TEXT NOT NULL
              CHECK (length(group_name) >= 1 AND length(group_name) <= 50),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 按用户 + 分组名筛选分组成员（列表 group_name 筛选走此索引）
CREATE INDEX IF NOT EXISTS ix_watch_item_groups_user_group
  ON watch_item_groups (user_id, group_name);
