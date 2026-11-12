-- TASK-04B：采集任务与来源健康记录（Private 库，PRD 任务行 1288–1294 / §10.4 / §11.1-11）
--   - ingest_jobs：internal 任务开始/完成记录（jobs/start 过 source-gate 门禁，未 approved 来源连任务都起不来）。
--   - source_health_reports：来源健康上报 append-only（health/source 不设资格门禁——
--     健康上报反映的恰恰可能是来源不可用，down/degraded 必须能记录）。
-- source_id/city_code 跨库引用 Public 库（SQLite 无跨库外键），由应用层经 source-gate 校验。
-- 幂等（IF NOT EXISTS），迁移可重复运行。
CREATE TABLE IF NOT EXISTS ingest_jobs (
  job_id      TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  city_code   TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'running'
              CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_code  TEXT,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS ix_ingest_jobs_source_started
  ON ingest_jobs (source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS ix_ingest_jobs_status_started
  ON ingest_jobs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS source_health_reports (
  report_id  TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL,
  status     TEXT NOT NULL
             CHECK (status IN ('ok', 'degraded', 'down')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  detail     TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_source_health_source_checked
  ON source_health_reports (source_id, checked_at DESC);
