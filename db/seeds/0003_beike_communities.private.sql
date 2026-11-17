-- TASK-09：beike 授权审批记录——Private 库种子（幂等，本地/远端同一文件）
-- 与 0003_beike_communities.public.sql 配套（D1 按库执行，种子按库拆分）。
-- §9.2/§5.3 红线：审批证据材料只留 Private 库；本文件不含真实个人邮箱与合同正文。
-- 授权依据：负责人 2026-11-17 裁决（.trae/specs/cross-source-price-collection/spec.md §0-1：
--   科研调查用途放行低频公开挂牌页采集，同 04D fang_com 先例）。
-- 幂等：INSERT ... ON CONFLICT，可重复执行。

-- 1) §5.3 审批记录（append-only；负责人裁决为证据；u_system_ops 由 0002 种子建立，幂等兜底）
INSERT INTO users (user_id, email_normalized, email_verified_at, status)
VALUES ('u_system_ops', 'system@radar.internal', datetime('now'), 'active')
ON CONFLICT(user_id) DO UPDATE SET
  status = excluded.status;

INSERT INTO source_approvals (
  approval_id, source_id, action, approver_user_id, evidence_ref,
  permitted_fields_json, permitted_purposes_json, allowed_cities_json,
  frequency, retention_period, valid_until, status_after, note
)
VALUES (
  'apr_beike_0001',
  'beike',
  'approve',
  'u_system_ops',
  '.trae/specs/cross-source-price-collection/spec.md §0-1（负责人 2026-11-17 裁决：科研调查用途放行贝壳低频公开挂牌页采集，robots 全站 Disallow/协议禁爬风险由裁决承担并留痕）',
  '["listing_total_price","listing_unit_price","listing_area","listing_count"]',
  '["research_validation_only"]',
  '["370200"]',
  'on_demand_validation_only',
  'raw_html_never_stored_90d_observations',
  NULL,
  'approved_licensed',
  '仅青岛 16 个 00B 核验小区公开挂牌列表首页（当前公开可核验 2 个，其余置 null 零请求）；每小区 ≤30 套；限速 ≥1s；不入 cron/workflow；不绕过登录/验证码/访问控制（2026-11-17 实测站点匿名强制登录，采集器如实报 down）；不存原始 HTML；风险与执行边界见 docs/TASK-09-跨源房价获取验收报告.md'
)
ON CONFLICT(approval_id) DO UPDATE SET
  evidence_ref = excluded.evidence_ref,
  note         = excluded.note;
