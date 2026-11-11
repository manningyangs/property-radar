-- TASK-02A：Private D1（radar_private）初始 schema——PRD V1.2 §9.2 / §9.3 / §9.4
-- 约束：
--   1) 本库保存全部用户数据，永不直连客户端（§9.4）；
--   2) 所有 user-owned 表必含 user_id 并建立外键，查询时强制校验（§9.4）；
--   3) 全部语句幂等（IF NOT EXISTS），迁移可重复运行；
--   4) city_code 指向 Public DB 的 cities，SQLite 不支持跨库外键，由应用层校验（见各列注释）。

-- ============================================================ 用户（§9.2 users）
-- 不收集真实姓名、手机号、身份证；只存邮箱（规范化小写）。
CREATE TABLE IF NOT EXISTS users (
  user_id           TEXT PRIMARY KEY,
  email_normalized  TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  status            TEXT NOT NULL DEFAULT 'active',   -- 枚举由应用层（§2.9）约束
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at     TEXT,
  deleted_at        TEXT
);

-- ============================================================ 邮箱验证码（§9.2 email_otps）
-- 只存哈希，不存明文；到期与消费后定期清理。登录前用户可能不存在，故不设 users 外键。
CREATE TABLE IF NOT EXISTS email_otps (
  otp_id                   TEXT PRIMARY KEY,
  email_normalized         TEXT NOT NULL,
  code_hash                TEXT NOT NULL,
  purpose                  TEXT NOT NULL DEFAULT 'login',
  expires_at               TEXT NOT NULL,
  attempt_count            INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  consumed_at              TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  request_fingerprint_hash TEXT
);

CREATE INDEX IF NOT EXISTS ix_email_otps_email_purpose_expires
  ON email_otps (email_normalized, purpose, expires_at);

-- ============================================================ 会话（§9.2 sessions）
-- 浏览器只持随机 token 的 HttpOnly cookie；库内存 token 哈希。
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS ix_sessions_token_expires ON sessions (token_hash, expires_at);
CREATE INDEX IF NOT EXISTS ix_sessions_user          ON sessions (user_id, expires_at);

-- ============================================================ 城市覆盖申请（§9.2 city_coverage_requests）
-- 未知城市允许 city_code 为空；reason 不得要求敏感个人信息。
CREATE TABLE IF NOT EXISTS city_coverage_requests (
  request_id              TEXT PRIMARY KEY,
  user_id                 TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  city_code               TEXT,            -- 跨库引用 cities，应用层校验；未知城市为 NULL
  requested_city_name     TEXT NOT NULL,
  requested_province_name TEXT,
  requested_admin_code    TEXT,
  reason                  TEXT,
  status                  TEXT NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'reviewing', 'approved', 'rejected')),
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at             TEXT
);

CREATE INDEX IF NOT EXISTS ix_covreq_user_created  ON city_coverage_requests (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_covreq_status        ON city_coverage_requests (status, created_at DESC);

-- ============================================================ 用户城市（§9.2 user_cities）
-- city_code 跨库引用 cities（应用层校验）；(user_id, city_code) 唯一。
CREATE TABLE IF NOT EXISTS user_cities (
  user_id   TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  city_code TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, city_code)
);

CREATE INDEX IF NOT EXISTS ix_user_cities_user ON user_cities (user_id, created_at DESC);

-- ============================================================ 监控对象（§9.2 watch_items）
CREATE TABLE IF NOT EXISTS watch_items (
  watch_id               TEXT PRIMARY KEY,
  user_id                TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  object_type            TEXT NOT NULL
                         CHECK (object_type IN ('region', 'community', 'listing')),
  object_id              TEXT NOT NULL,     -- 指向 Public DB 对象，跨库引用
  display_name_snapshot  TEXT NOT NULL,
  priority               INTEGER NOT NULL DEFAULT 0,   -- 越大越高，应用层定义档位
  status                 TEXT NOT NULL DEFAULT 'active',
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, object_type, object_id)
);

CREATE INDEX IF NOT EXISTS ix_watch_items_user_status_created
  ON watch_items (user_id, status, created_at DESC);

-- ============================================================ 监控规则（§9.2 watch_rules）
CREATE TABLE IF NOT EXISTS watch_rules (
  rule_id        TEXT PRIMARY KEY,
  watch_id       TEXT NOT NULL REFERENCES watch_items (watch_id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  rule_type      TEXT NOT NULL,             -- 规则类型枚举见 §3.1，应用层约束
  metric_code    TEXT NOT NULL,
  price_type     TEXT,
  target_value   REAL,                      -- 目标价；百分比类规则可空
  currency       TEXT NOT NULL DEFAULT 'CNY',
  unit           TEXT,
  window_days    INTEGER CHECK (window_days IS NULL OR window_days > 0),
  threshold_pct  REAL,
  hysteresis_pct REAL,
  is_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (is_enabled IN (0, 1)),
  armed_state    TEXT NOT NULL DEFAULT 'armed',  -- 布防/触发状态，状态机见 §3.1
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)  -- 乐观锁
);

CREATE INDEX IF NOT EXISTS ix_watch_rules_user_enabled_type
  ON watch_rules (user_id, is_enabled, rule_type);
CREATE INDEX IF NOT EXISTS ix_watch_rules_watch ON watch_rules (watch_id);

-- ============================================================ 告警事件（§9.2 alert_events）
-- snapshot_id 指向 Public DB 的 price_snapshots（跨库，无外键）；
-- event_key 为幂等去重键（同一规则同一次跨越只生成一条）。
CREATE TABLE IF NOT EXISTS alert_events (
  event_id       TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  rule_id        TEXT REFERENCES watch_rules (rule_id) ON DELETE CASCADE,
  watch_id       TEXT REFERENCES watch_items (watch_id) ON DELETE CASCADE,
  snapshot_id    TEXT,
  event_type     TEXT NOT NULL,
  old_value      REAL,
  new_value      REAL,
  target_value   REAL,
  difference_pct REAL,
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  event_key      TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  read_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'unread'
);

CREATE INDEX IF NOT EXISTS ix_alert_events_user_created
  ON alert_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_alert_events_watch ON alert_events (watch_id);

-- ============================================================ 通知偏好（§9.2 notification_preferences）
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id              TEXT PRIMARY KEY REFERENCES users (user_id) ON DELETE CASCADE,
  email_enabled        INTEGER NOT NULL DEFAULT 1 CHECK (email_enabled IN (0, 1)),
  digest_enabled       INTEGER NOT NULL DEFAULT 0 CHECK (digest_enabled IN (0, 1)),
  digest_time          TEXT,                -- 'HH:MM'，应用层校验
  browser_push_enabled INTEGER NOT NULL DEFAULT 0 CHECK (browser_push_enabled IN (0, 1)),
  timezone             TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================ 通知投递（§9.2 notification_deliveries）
-- 额度耗尽等状态（quota_deferred/quota_blocked/provider_error/blocked，见 §11）由应用层写入；
-- 邮件失败不删除站内事件。
CREATE TABLE IF NOT EXISTS notification_deliveries (
  delivery_id         TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL REFERENCES alert_events (event_id) ON DELETE CASCADE,
  user_id             TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  channel             TEXT NOT NULL,        -- email / in_app / browser_push
  provider            TEXT,                 -- apps_script / brevo / resend / ...
  status              TEXT NOT NULL DEFAULT 'pending',
  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  provider_message_id TEXT,
  last_error_code     TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at             TEXT
);

CREATE INDEX IF NOT EXISTS ix_deliveries_status_created
  ON notification_deliveries (status, created_at);
CREATE INDEX IF NOT EXISTS ix_deliveries_user_created
  ON notification_deliveries (user_id, created_at DESC);

-- ============================================================ 用户同意记录（§9.2 user_consents）
-- source_ip_hash 只存哈希，不存原始 IP。
CREATE TABLE IF NOT EXISTS user_consents (
  consent_id     TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL,
  consent_type   TEXT NOT NULL,             -- privacy_policy / terms / email_notification 等
  consented_at   TEXT NOT NULL DEFAULT (datetime('now')),
  withdrawn_at   TEXT,
  source_ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS ix_consents_user ON user_consents (user_id, consent_type);

-- ============================================================ 管理员（§9.2 admin_roles）
CREATE TABLE IF NOT EXISTS admin_roles (
  admin_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
  role         TEXT NOT NULL,               -- 角色枚举由后台服务约束
  mfa_required INTEGER NOT NULL DEFAULT 1 CHECK (mfa_required IN (0, 1)),
  created_by   TEXT,                        -- 授权者（管理员或系统），应用层校验
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS ix_admin_roles_user ON admin_roles (user_id, revoked_at);

-- ============================================================ 审计日志（§9.2 audit_logs）
-- 管理员跨用户访问必须写审计；actor_user_id 不设外键，保证用户注销后日志仍完整。
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id       TEXT PRIMARY KEY,
  actor_user_id  TEXT,
  actor_role     TEXT,
  action         TEXT NOT NULL,
  resource_type  TEXT,
  resource_id    TEXT,
  reason         TEXT,
  request_id     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_created   ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_logs_actor      ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_logs_resource   ON audit_logs (resource_type, resource_id);
