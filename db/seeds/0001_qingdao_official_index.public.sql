-- TASK-04C：青岛市统计局住宅价格指数——Public 库种子（幂等，本地/远端同一文件）
-- 与 private/0001_qingdao_official_index.private.sql 配套（D1 按库执行，种子按库拆分）。
-- 证据与审批材料见 docs/TASK-04C-青岛市统计局住宅价格指数核验报告.md（五要素 + 手工样例核对）。
-- 幂等：INSERT ... ON CONFLICT，可重复执行。

-- 1) 城市目录（仅市级官方指数覆盖，无区县/小区）
INSERT INTO cities (city_code, name, province_code, timezone, status, catalog_status, coverage_level, coverage_note)
VALUES (
  '370200', '青岛市', '370000', 'Asia/Shanghai',
  'active', 'active', 'city',
  '仅市级官方价格指数（新建/二手住宅，同比与环比）；无区县级、无小区级数据'
)
ON CONFLICT(city_code) DO UPDATE SET
  name           = excluded.name,
  status         = excluded.status,
  catalog_status = excluded.catalog_status,
  coverage_level = excluded.coverage_level,
  coverage_note  = excluded.coverage_note,
  updated_at     = datetime('now');

-- 2) 公开数据源说明（只含已验证字段口径；合同/密钥/联系方式不入 Public DB）
INSERT INTO data_sources_public (
  source_id, name, source_type, official_url, data_scope,
  license_note_url, display_scope, last_verified_at
)
VALUES (
  'qd_stats_price_index',
  '青岛市统计局 住宅价格指数',
  'government_statistics',
  'http://qdtj.qingdao.gov.cn/tongjisj/tjsj_42452/tjj_tjsj_jgzs/zzjgzs/',
  '青岛市全市（370200）新建/二手住宅销售价格指数，月度：本月(上年同月=100) 同比、环比(上月=100)；指数口径非金额，来源不公布样本量',
  'http://qdtj.qingdao.gov.cn/tongjisj/tjsj_42452/tjj_tjsj_jgzs/zzjgzs/',
  '仅展示已验证字段：new_build_yoy_index / new_build_mom_index / resale_yoy_index / resale_mom_index / report_period / publish_date；未验证字段（定基指数、区县级指数、成交价）不作为已验证指标展示',
  '2026-11-12'
)
ON CONFLICT(source_id) DO UPDATE SET
  name             = excluded.name,
  source_type      = excluded.source_type,
  official_url     = excluded.official_url,
  data_scope       = excluded.data_scope,
  license_note_url = excluded.license_note_url,
  display_scope    = excluded.display_scope,
  last_verified_at = excluded.last_verified_at,
  updated_at       = datetime('now');

-- 3) 许可状态机（§5.2 approved_open：官网免费公开发布；复核日期 2027-11-12）
INSERT INTO source_license_state (source_id, status, valid_until)
VALUES ('qd_stats_price_index', 'approved_open', '2027-11-12')
ON CONFLICT(source_id) DO UPDATE SET
  status      = excluded.status,
  valid_until = excluded.valid_until,
  updated_at  = datetime('now');

-- 4) 数据源×城市覆盖（run_guard 的服务端判定来源：370200 / city / 两个指标）
INSERT INTO source_city_coverage (
  source_id, city_code, object_level, metric_codes_json,
  authorization_status, last_verified_at
)
VALUES (
  'qd_stats_price_index', '370200', 'city',
  '["new_house_price_index","second_hand_price_index"]',
  'approved_open', '2026-11-12'
)
ON CONFLICT(source_id, city_code, object_level) DO UPDATE SET
  metric_codes_json    = excluded.metric_codes_json,
  authorization_status = excluded.authorization_status,
  last_verified_at     = excluded.last_verified_at;

-- 5) 字段验证状态（PRD 验收②：未验证字段不展示为已验证指标）
--    verified：对接前手工样例核对实测（2026-09 期，2026-11-03 发布，核验报告 §6）
INSERT INTO source_field_verifications (source_id, field_code, field_label, metric_code, status, evidence, verified_at)
VALUES
  ('qd_stats_price_index', 'new_build_yoy_index', '新建商品住宅价格指数（本月，上年同月=100）',
   'new_house_price_index', 'verified',
   '2026-09 期实测 99.1（2026-11-03 发布，详情页单表格第3行同比列）', '2026-11-12'),
  ('qd_stats_price_index', 'new_build_mom_index', '新建商品住宅价格指数（环比，上月=100）',
   'new_house_price_index', 'verified',
   '2026-09 期实测 100.2（详情页单表格第3行环比列）', '2026-11-12'),
  ('qd_stats_price_index', 'resale_yoy_index', '二手住宅价格指数（本月，上年同月=100）',
   'second_hand_price_index', 'verified',
   '2026-09 期实测 95.0（详情页单表格第4行同比列）', '2026-11-12'),
  ('qd_stats_price_index', 'resale_mom_index', '二手住宅价格指数（环比，上月=100）',
   'second_hand_price_index', 'verified',
   '2026-09 期实测 99.9（详情页单表格第4行环比列）', '2026-11-12'),
  ('qd_stats_price_index', 'report_period', '报告期（YYYY年M月）',
   NULL, 'verified',
   '2026-09 期实测「报告期：2026年9月」，与列表页期次一致', '2026-11-12'),
  ('qd_stats_price_index', 'publish_date', '发布日期（YYYY-MM-DD）',
   NULL, 'verified',
   '列表页实测 2026-11-03（2026 年 9 月期）', '2026-11-12'),
  ('qd_stats_price_index', 'base_index', '定基价格指数',
   NULL, 'unverified',
   '页面无定基指数列（核验报告 §2：明确未验证，不展示为已验证指标）', NULL),
  ('qd_stats_price_index', 'district_level_index', '区县级价格指数',
   NULL, 'unverified',
   '页面无区县维度（核验报告 §3：区域仅市级）', NULL),
  ('qd_stats_price_index', 'transaction_price', '成交价/绝对价格字段',
   NULL, 'unverified',
   '页面不提供绝对成交价（核验报告 §2/§5：指数非金额）', NULL)
ON CONFLICT(source_id, field_code) DO UPDATE SET
  field_label = excluded.field_label,
  metric_code = excluded.metric_code,
  status      = excluded.status,
  evidence    = excluded.evidence,
  verified_at = excluded.verified_at;
