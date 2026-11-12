-- TASK-04A：数据源审批与批次受理（Private 库，PRD 任务行 1280–1286 / §5.3 审核清单 / §9.2 / §10.4）
--   - source_approvals：审批记录 **append-only**（只 INSERT，无 UPDATE/DELETE 路径），
--     审批证据（证据链接/合同编号、许可字段、用途、覆盖范围、频率、保存期限、审批人）只留此库，
--     不入 Public DB；停用动作以 audit_logs 为准，不写本表。
--   - ingest_batches：internal 批次受理元数据（04A 只做门禁与受理记录，不解析观测明细——清洗属 04E）。
--   - ingest_nonces：HMAC 防重放 nonce 台账（时间戳 + nonce + 签名三件套之一）。
-- source_id/city_code 跨库引用 Public 库（SQLite 无跨库外键），由应用层校验。
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS source_approvals (
  approval_id             TEXT PRIMARY KEY,
  source_id               TEXT NOT NULL,
  action                  TEXT NOT NULL DEFAULT 'approve'
                          CHECK (action IN ('approve')),
  approver_user_id        TEXT NOT NULL REFERENCES users (user_id),
  evidence_ref            TEXT NOT NULL,
  permitted_fields_json   TEXT NOT NULL DEFAULT '[]',
  permitted_purposes_json TEXT NOT NULL DEFAULT '[]',
  allowed_cities_json     TEXT NOT NULL DEFAULT '[]',
  frequency               TEXT NOT NULL,
  retention_period        TEXT NOT NULL,
  valid_until             TEXT CHECK (valid_until IS NULL
                                      OR valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status_after            TEXT NOT NULL
                          CHECK (status_after IN ('approved_open', 'approved_licensed')),
  note                    TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_source_approvals_source_created
  ON source_approvals (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_source_approvals_approver
  ON source_approvals (approver_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ingest_batches (
  batch_id     TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  city_code    TEXT NOT NULL,
  object_level TEXT NOT NULL
               CHECK (object_level IN ('city', 'district', 'community', 'listing')),
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_ingest_batches_source_received
  ON ingest_batches (source_id, received_at DESC);

CREATE TABLE IF NOT EXISTS ingest_nonces (
  nonce      TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_ingest_nonces_expires ON ingest_nonces (expires_at);
