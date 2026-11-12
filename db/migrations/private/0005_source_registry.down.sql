-- TASK-04A 回滚：删除审批/批次/防重放三表（子表先删，顺序无关但保持惯例）
DROP TABLE IF EXISTS ingest_nonces;
DROP TABLE IF EXISTS ingest_batches;
DROP TABLE IF EXISTS source_approvals;
