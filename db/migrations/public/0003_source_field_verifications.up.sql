-- TASK-04C：数据源字段验证状态（PRD 任务行 1296–1302 验收②「任何字段未验证则不展示为已验证指标」）
-- 只记录"逐字段"的验证结论（对接前手工样例核对），不存原始 HTML/样本明细；
-- 公开接口 /public/methodology/sources 仅把 status='verified' 且 metric_code 非空的行计入 verified_metrics，
-- status='unverified' 的字段行原样返回且绝不计入已验证指标。
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS source_field_verifications (
  source_id   TEXT NOT NULL REFERENCES data_sources_public (source_id),
  field_code  TEXT NOT NULL CHECK (length(field_code) > 0),
  field_label TEXT NOT NULL CHECK (length(field_label) > 0),
  metric_code TEXT,
  status      TEXT NOT NULL DEFAULT 'unverified'
              CHECK (status IN ('verified', 'unverified')),
  evidence    TEXT,
  verified_at TEXT CHECK (verified_at IS NULL
                          OR verified_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  PRIMARY KEY (source_id, field_code)
);
