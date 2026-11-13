-- TASK-05C：浏览器 Web Push 订阅（Private 库，PRD 任务行 1336–1342 / §7.2 / §9.4）
--   - endpoint：Push Service 端点（含机密路径段），UNIQUE 幂等 upsert；
--   - p256dh/auth：RFC 8291 载荷加密所需订阅密钥（base64url），仅入私库；
--   - last_seen_at：发送成功/重新订阅时刷新，cron 清理超过 60 天未活跃的休眠订阅；
--   - status：active=可发送；stale=预留（失效标记，实际删除走 404/410 即删）。
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'stale')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_push_subs_user_status
  ON push_subscriptions (user_id, status);
