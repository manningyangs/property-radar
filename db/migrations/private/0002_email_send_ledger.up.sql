-- TASK-02C：邮件发送配额账本（PRD §7.1 免费额度降级）
-- 应用硬上限：80 个收件人/滚动24小时，OTP 预留 60 封；每次发送前按本表求和核验，
-- 达到硬上限即停止调用邮件商（不得自动切换付费服务）。
-- 幂等；账本只记发送结果，不存收件人明文（收件信息仅在 email_otps/users 内）。
CREATE TABLE IF NOT EXISTS email_send_ledger (
  ledger_id       TEXT PRIMARY KEY,
  template        TEXT NOT NULL
                  CHECK (template IN ('otp', 'price_alert', 'daily_digest')),
  recipient_count INTEGER NOT NULL DEFAULT 1 CHECK (recipient_count >= 0),
  provider        TEXT NOT NULL,            -- EmailProvider 实现名（google_apps_script_mail/...）
  status          TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('sent', 'failed', 'quota_blocked')),
  request_id      TEXT,                     -- 关联 Worker 请求 ID（日志可追溯，不含敏感信息）
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_email_send_ledger_created
  ON email_send_ledger (created_at, status, template);
