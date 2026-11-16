-- TASK-06A：管理员 MFA（PRD 任务行 1346–1352 / §8.4 管理员安全 / §7.6 关键动作二次确认）
--   - admin_mfa_secrets：每管理员一个 TOTP（RFC 6238）密钥；confirmed_at 为空 = setup 后未 verify
--     （不可用于放行）；last_used_step 防重放（同一时间步的验证码不得二次使用）；
--   - admin_mfa_sessions：session 级 MFA 已验证标记（每登录会话独立验证，新会话需重验）；
--     FK 级联 sessions——会话撤销/删除即失效；查询时仍需 join 校验 expires_at/revoked_at；
--     带 user_id（§9.4 user-owned 不变量 + disable 时按用户批量清理其全部会话标记）；
-- 不 ALTER sessions（SQLite ADD COLUMN 非幂等，与 0002/0004 私库同策略用新表）。
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS admin_mfa_secrets (
  user_id         TEXT PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
  secret_base32   TEXT NOT NULL,
  confirmed_at    TEXT,
  last_used_step  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_mfa_sessions (
  session_id  TEXT PRIMARY KEY REFERENCES sessions (session_id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  verified_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_admin_mfa_sessions_user
  ON admin_mfa_sessions (user_id);
