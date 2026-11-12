-- TASK-04A：数据源许可状态机（PRD 任务行 1280–1286 / §5.2 七态 / §9.1）
-- 不 ALTER data_sources_public（SQLite ADD COLUMN 非幂等，与 0003/0004 同策略用新表）：
--   - data_sources_public 只存公开说明；本表只存"当前许可状态 + 授权到期日"；
--   - 审批证据/合同编号/许可字段/用途等私有材料存 Private 库 source_approvals（§9.1 红线：合同不入 Public DB）；
--   - valid_until 过期时由应用层（source-gate.resolveLicense）惰性自动 suspend 并写审计。
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS source_license_state (
  source_id   TEXT PRIMARY KEY REFERENCES data_sources_public (source_id),
  status      TEXT NOT NULL DEFAULT 'discovered'
              CHECK (status IN (
                'discovered', 'pending_review', 'manual_only',
                'approved_open', 'approved_licensed', 'suspended', 'blocked'
              )),
  valid_until TEXT CHECK (valid_until IS NULL
                          OR valid_until GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
