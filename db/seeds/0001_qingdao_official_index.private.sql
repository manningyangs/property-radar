-- TASK-04C：青岛市统计局住宅价格指数——Private 库种子（幂等，本地/远端同一文件）
-- 与 0001_qingdao_official_index.public.sql 配套（D1 按库执行，种子按库拆分）。
-- §9.2/§5.3 红线：审批证据材料只留 Private 库；本文件不含真实个人邮箱与合同正文。
-- 幂等：INSERT ... ON CONFLICT，可重复执行。

-- 1) 系统引导审批人（满足 source_approvals.approver_user_id 外键；非真实邮箱）
INSERT INTO users (user_id, email_normalized, email_verified_at, status)
VALUES ('u_system_ops', 'system@radar.internal', datetime('now'), 'active')
ON CONFLICT(user_id) DO UPDATE SET
  status = excluded.status;

-- 2) §5.3 审批记录（append-only；引导审批 + 核验报告为证据）
INSERT INTO source_approvals (
  approval_id, source_id, action, approver_user_id, evidence_ref,
  permitted_fields_json, permitted_purposes_json, allowed_cities_json,
  frequency, retention_period, valid_until, status_after, note
)
VALUES (
  'apr_qd_stats_price_index_0001',
  'qd_stats_price_index',
  'approve',
  'u_system_ops',
  'http://qdtj.qingdao.gov.cn/tongjisj/tjsj_42452/tjj_tjsj_jgzs/zzjgzs/',
  '["new_build_yoy_index","new_build_mom_index","resale_yoy_index","resale_mom_index","report_period","publish_date"]',
  '["trend_calibration","methodology_display"]',
  '["370200"]',
  'monthly',
  'public_index_aggregates_only',
  '2027-11-12',
  'approved_open',
  '系统引导审批（04C 任务）；五要素核验与手工样例核对见 docs/TASK-04C-青岛市统计局住宅价格指数核验报告.md；官网免费公开发布，指数口径不落原始 HTML'
)
ON CONFLICT(approval_id) DO UPDATE SET
  evidence_ref = excluded.evidence_ref,
  note         = excluded.note;
