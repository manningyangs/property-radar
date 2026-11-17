-- TASK-09：beike（贝壳 qd.ke.com）来源登记——Public 库种子（幂等，本地/远端同一文件）
-- 与 0003_beike_communities.private.sql 配套（审批记录按库拆分）。
-- 授权依据：负责人 2026-11-17 裁决（.trae/specs/cross-source-price-collection/spec.md §0-1：
--   科研调查用途放行低频公开挂牌页采集，同 04D fang_com 先例；robots 全站 Disallow 风险由裁决承担并留痕）。
-- 实测边界：2026-11-17 站点已对匿名访客强制登录（登录墙+验证码墙），采集器遇墙如实报 down，零绕过。
-- 幂等：INSERT ... ON CONFLICT，可重复执行。

-- 1) 公开数据源说明（beike；合同/密钥不入 Public DB）
INSERT INTO data_sources_public (
  source_id, name, source_type, official_url, data_scope,
  license_note_url, display_scope, last_verified_at
)
VALUES (
  'beike', '贝壳找房', 'portal_listing', 'https://qd.ke.com/',
  '青岛（370200）16 个 00B 核验小区中公开可核验小区的挂牌列表首页样本：总价/单价/面积/套数（挂牌 ask 非成交）；与房天下形成双源交叉核验',
  'https://qd.ke.com/robots.txt',
  '仅展示已验证字段：listing_total_price / listing_unit_price / listing_area / listing_count；成交价、下架日期等未验证字段不作为已验证指标',
  '2026-11-17'
)
ON CONFLICT (source_id) DO UPDATE SET
  name             = excluded.name,
  source_type      = excluded.source_type,
  official_url     = excluded.official_url,
  data_scope       = excluded.data_scope,
  license_note_url = excluded.license_note_url,
  display_scope    = excluded.display_scope,
  last_verified_at = excluded.last_verified_at,
  updated_at       = datetime('now');

-- 2) 许可状态机（§5.2 approved_licensed：负责人 2026-11-17 裁决授权，无到期日）
INSERT INTO source_license_state (source_id, status, valid_until)
VALUES ('beike', 'approved_licensed', NULL)
ON CONFLICT (source_id) DO UPDATE SET
  status      = excluded.status,
  valid_until = excluded.valid_until,
  updated_at  = datetime('now');

-- 3) 数据源×城市覆盖（run_guard/批次门禁的判定来源；community 与 listing 两级）
INSERT INTO source_city_coverage (
  source_id, city_code, object_level, metric_codes_json,
  authorization_status, last_verified_at
)
VALUES
  ('beike', '370200', 'community',
   '["community_ask_median_unit","listing_ask_unit"]',
   'approved_licensed', '2026-11-17'),
  ('beike', '370200', 'listing',
   '["listing_ask_unit"]',
   'approved_licensed', '2026-11-17')
ON CONFLICT (source_id, city_code, object_level) DO UPDATE SET
  metric_codes_json    = excluded.metric_codes_json,
  authorization_status = excluded.authorization_status,
  last_verified_at     = excluded.last_verified_at;

-- 4) 字段验证状态（初始一律 unverified——禁止未实测先标 verified；
--    贝壳当前对匿名访客登录墙拦截，真实解析实测完成前不得回填 verified）
INSERT INTO source_field_verifications (source_id, field_code, field_label, metric_code, status, evidence, verified_at)
VALUES
  ('beike', 'listing_total_price', '挂牌总价（万）',
   'listing_ask_unit', 'unverified', '2026-11-17 实测匿名访问命中登录墙，待放开后首批真实解析实测回填', NULL),
  ('beike', 'listing_unit_price', '挂牌单价（元/㎡）',
   'listing_ask_unit', 'unverified', '2026-11-17 实测匿名访问命中登录墙，待放开后首批真实解析实测回填', NULL),
  ('beike', 'listing_area', '建筑面积（㎡）',
   NULL, 'unverified', '2026-11-17 实测匿名访问命中登录墙，待放开后首批真实解析实测回填', NULL),
  ('beike', 'listing_count', '在售套数',
   NULL, 'unverified', '2026-11-17 实测匿名访问命中登录墙，待放开后首批真实解析实测回填', NULL)
ON CONFLICT (source_id, field_code) DO UPDATE SET
  field_label = excluded.field_label,
  metric_code = excluded.metric_code,
  status      = excluded.status,
  evidence    = excluded.evidence,
  verified_at = excluded.verified_at;

-- 5) 城市覆盖口径更新：双源挂牌样本与交叉核验（TASK-09）
UPDATE cities
   SET coverage_level = 'community',
       coverage_note  = '市级官方价格指数（新建/二手）+ 16 个已核验小区的挂牌样本双源交叉核验（TASK-04D 房天下 + TASK-09 贝壳，公开列表页，仅验证管线；双源中位数偏差>15% 标 outlier）',
       updated_at     = datetime('now')
 WHERE city_code = '370200';
