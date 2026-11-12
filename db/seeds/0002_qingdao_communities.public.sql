-- TASK-04D：青岛 16 个已核验小区（00B 目录层）+ fang_com 授权种子——Public 库（幂等，本地/远端同一文件）
-- 与 0002_qingdao_communities.private.sql 配套（审批记录按库拆分）。
-- 授权依据：负责人 2026-11-12 裁决（spec §0-1：任务书 04D 禁爬红线更正为允许，仅验证用途）。
-- 红线：只导入 00B 已核验的 16 个小区，不导入全国全量（00B 报告 §1）。
-- 幂等：INSERT ... ON CONFLICT，可重复执行。

-- 1) 城市覆盖口径更新：官方指数（市级）+ 小区挂牌样本（16 个已核验小区）
UPDATE cities
   SET coverage_level = 'community',
       coverage_note  = '市级官方价格指数（新建/二手）+ 16 个已核验小区的挂牌样本（TASK-04D，房天下公开列表页，仅验证管线）',
       updated_at     = datetime('now')
 WHERE city_code = '370200';

-- 2) 9 个取样区（00B 核验清单第 9 条；region_code 为国标区划码）
INSERT INTO regions (region_id, parent_id, city_code, region_code, name, level, is_active, source_id, updated_at)
VALUES
  ('rg_370202', NULL, '370200', '370202', '市南区', 'district', 1, NULL, datetime('now')),
  ('rg_370203', NULL, '370200', '370203', '市北区', 'district', 1, NULL, datetime('now')),
  ('rg_370211', NULL, '370200', '370211', '黄岛区', 'district', 1, NULL, datetime('now')),
  ('rg_370212', NULL, '370200', '370212', '崂山区', 'district', 1, NULL, datetime('now')),
  ('rg_370213', NULL, '370200', '370213', '李沧区', 'district', 1, NULL, datetime('now')),
  ('rg_370214', NULL, '370200', '370214', '城阳区', 'district', 1, NULL, datetime('now')),
  ('rg_370215', NULL, '370200', '370215', '即墨区', 'district', 1, NULL, datetime('now')),
  ('rg_370281', NULL, '370200', '370281', '胶州市', 'county', 1, NULL, datetime('now')),
  ('rg_370285', NULL, '370200', '370285', '莱西市', 'county', 1, NULL, datetime('now'))
ON CONFLICT (region_id) DO UPDATE SET
  name       = excluded.name,
  region_code = excluded.region_code,
  updated_at = excluded.updated_at;

-- 3) 16 个已核验小区（确定性 ID 与 00B 清单顺序一致；address_coarse 只取门牌，无门牌留 NULL）
INSERT INTO communities (
  community_id, city_code, region_id, name, alias_json, address_coarse,
  block_name, built_year, identity_source, status, created_at, updated_at
)
VALUES
  ('cmt_qd_01', '370200', 'rg_370202', '新贵都',
   '["新贵都一期","新贵都二期"]', '徐州路2号', '浮山所板块', 2002, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_02', '370200', 'rg_370202', '中海银海一号',
   '["银海一号","中海银海1号"]', '银川西路7号', '天山板块', 2011, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_03', '370200', 'rg_370203', '城市花园',
   '["城市花园一期","城市花园二期"]', '南口路2号', '海泊桥板块', 2001, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_04', '370200', 'rg_370203', '浮山后四小区',
   '["浮山后四小区（同安路）"]', '同安路41号', '浮山后板块', 2000, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_05', '370200', 'rg_370203', '幸福花园',
   '["沙岭庄幸福花园"]', NULL, '沙岭庄板块', 2001, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_06', '370200', 'rg_370212', '鲁信长春花园',
   '["长春花园（鲁信）"]', '银川东路1号', '颐中体育场板块', 2006, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_07', '370200', 'rg_370212', '鲁信未央花园',
   '[]', '海青路6号', '浮山前板块', 2004, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_08', '370200', 'rg_370213', '百通馨苑',
   '["百通馨苑一区","百通馨苑三区","百通馨苑社区"]', '金水路753号', '东李板块', 2005, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_09', '370200', 'rg_370213', '中海国际社区',
   '["九水花园","中海国际社区一里城","中海国际社区御城"]', NULL, '九水路板块', 2013, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_10', '370200', 'rg_370214', '卓越蔚蓝群岛',
   '["卓越蔚蓝公馆","蔚蓝群岛一期"]', '双元路18号', '流亭板块', NULL, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_11', '370200', 'rg_370214', '万科城市花园',
   '["万科城市花园一期","万科城市花园二期"]', '泰城路278号', '青岛北站板块', 2010, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_12', '370200', 'rg_370211', '千禧龙花园',
   '[]', '武夷山路167号', '长江路街道', 2003, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_13', '370200', 'rg_370211', '福瀛天麓湖',
   '["天麓湖","福瀛天麓湖·紫园"]', '韶山路568号', '薛家岛板块', 2015, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_14', '370200', 'rg_370215', '德馨珑湖',
   '["德馨·珑湖","德馨珑湖三期"]', '长江一路117号', '环秀板块', 2013, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_15', '370200', 'rg_370281', '绿城春晓苑',
   '[]', '北京东路277号', '三里河板块', 2012, 'task-00b-verification', 'active', datetime('now'), datetime('now')),
  ('cmt_qd_16', '370200', 'rg_370285', '宏远金田花园',
   '["金田花园（莱西）"]', '重庆路1号', '水集板块', 2008, 'task-00b-verification', 'active', datetime('now'), datetime('now'))
ON CONFLICT (community_id) DO UPDATE SET
  name           = excluded.name,
  alias_json     = excluded.alias_json,
  address_coarse = excluded.address_coarse,
  block_name     = excluded.block_name,
  built_year     = excluded.built_year,
  status         = excluded.status,
  updated_at     = excluded.updated_at;

-- 4) 公开数据源说明（fang_com；合同/密钥不入 Public DB）
INSERT INTO data_sources_public (
  source_id, name, source_type, official_url, data_scope,
  license_note_url, display_scope, last_verified_at
)
VALUES (
  'fang_com', '房天下', 'portal_listing', 'https://www.fang.com/',
  '青岛（370200）16 个已核验小区的公开挂牌列表首页样本：总价/单价/面积/套数（挂牌 ask 非成交）',
  'https://www.fang.com/robots.txt',
  '仅展示已验证字段：listing_total_price / listing_unit_price / listing_area / listing_count；成交价、下架日期等未验证字段不作为已验证指标',
  '2026-11-12'
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

-- 5) 许可状态机（§5.2 approved_licensed：负责人 2026-11-12 裁决授权，无到期日）
INSERT INTO source_license_state (source_id, status, valid_until)
VALUES ('fang_com', 'approved_licensed', NULL)
ON CONFLICT (source_id) DO UPDATE SET
  status      = excluded.status,
  valid_until = excluded.valid_until,
  updated_at  = datetime('now');

-- 6) 数据源×城市覆盖（run_guard/批次门禁的判定来源；community 与 listing 两级）
INSERT INTO source_city_coverage (
  source_id, city_code, object_level, metric_codes_json,
  authorization_status, last_verified_at
)
VALUES
  ('fang_com', '370200', 'community',
   '["community_ask_median_unit","listing_ask_unit"]',
   'approved_licensed', '2026-11-12'),
  ('fang_com', '370200', 'listing',
   '["listing_ask_unit"]',
   'approved_licensed', '2026-11-12')
ON CONFLICT (source_id, city_code, object_level) DO UPDATE SET
  metric_codes_json    = excluded.metric_codes_json,
  authorization_status = excluded.authorization_status,
  last_verified_at     = excluded.last_verified_at;

-- 7) 字段验证状态（未验证字段不进 verified_metrics；evidence 于首批真实解析后回填为 verified，
--    初始一律 unverified——见验收报告实测记录，禁止未实测先标 verified）
INSERT INTO source_field_verifications (source_id, field_code, field_label, metric_code, status, evidence, verified_at)
VALUES
  ('fang_com', 'listing_total_price', '挂牌总价（万/元）',
   'listing_ask_unit', 'unverified', '待首批真实解析实测回填（TASK-04D Task 6 本地验收）', NULL),
  ('fang_com', 'listing_unit_price', '挂牌单价（元/㎡）',
   'listing_ask_unit', 'unverified', '待首批真实解析实测回填（TASK-04D Task 6 本地验收）', NULL),
  ('fang_com', 'listing_area', '建筑面积（㎡）',
   NULL, 'unverified', '待首批真实解析实测回填（TASK-04D Task 6 本地验收）', NULL),
  ('fang_com', 'listing_count', '在售套数',
   NULL, 'unverified', '待首批真实解析实测回填（TASK-04D Task 6 本地验收）', NULL),
  ('fang_com', 'listing_deal_date', '成交日期',
   NULL, 'unverified', '挂牌列表页不提供成交日期（挂牌非成交）', NULL),
  ('fang_com', 'listing_listed_date', '上架日期',
   NULL, 'unverified', '列表页未取到该字段，不进已验证指标', NULL)
ON CONFLICT (source_id, field_code) DO UPDATE SET
  field_label = excluded.field_label,
  metric_code = excluded.metric_code,
  status      = excluded.status,
  evidence    = excluded.evidence,
  verified_at = excluded.verified_at;
