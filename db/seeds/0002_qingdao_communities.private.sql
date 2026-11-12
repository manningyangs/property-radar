-- TASK-04D：fang_com 授权审批记录——Private 库种子（幂等，本地/远端同一文件）
-- 与 0002_qingdao_communities.public.sql 配套（D1 按库执行，种子按库拆分）。
-- §9.2/§5.3 红线：审批证据材料只留 Private 库；本文件不含真实个人邮箱与合同正文。
-- 授权依据：负责人 2026-11-12 裁决（spec §0-1：任务书 04D 禁爬红线更正为允许，仅验证用途）。
-- 幂等：INSERT ... ON CONFLICT，可重复执行。

-- 1) 系统引导审批人（满足 source_approvals.approver_user_id 外键；非真实邮箱；0001 已建则幂等）
INSERT INTO users (user_id, email_normalized, email_verified_at, status)
VALUES ('u_system_ops', 'system@radar.internal', datetime('now'), 'active')
ON CONFLICT(user_id) DO UPDATE SET
  status = excluded.status;

-- 2) §5.3 审批记录（append-only；负责人裁决为证据）
INSERT INTO source_approvals (
  approval_id, source_id, action, approver_user_id, evidence_ref,
  permitted_fields_json, permitted_purposes_json, allowed_cities_json,
  frequency, retention_period, valid_until, status_after, note
)
VALUES (
  'apr_fang_com_0001',
  'fang_com',
  'approve',
  'u_system_ops',
  '.trae/specs/community-listing-pipeline/spec.md §0-1（负责人 2026-11-12 裁决：任务书 04D 禁爬红线更正为允许）',
  '["listing_total_price","listing_unit_price","listing_area","listing_count"]',
  '["validation_pipeline_only"]',
  '["370200"]',
  'on_demand_validation_only',
  'raw_html_never_stored_90d_observations',
  NULL,
  'approved_licensed',
  '仅青岛 16 个已核验小区公开挂牌列表首页；每小区 ≤30 套；限速 ≥1s；不入 cron/workflow；不碰贝壳/链家；风险与执行边界见 docs/TASK-04D-小区级数据接入验收报告.md'
)
ON CONFLICT(approval_id) DO UPDATE SET
  evidence_ref = excluded.evidence_ref,
  note         = excluded.note;
