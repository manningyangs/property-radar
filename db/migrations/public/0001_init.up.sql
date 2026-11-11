-- TASK-02A：Public D1（radar_public）初始 schema——PRD V1.2 §9.1 / §9.3 / §9.4
-- 约束：
--   1) 本库为公开数据，禁止出现任何用户数据 / 个人信息（§9.4）；
--   2) 全部语句幂等（IF NOT EXISTS），迁移可重复运行；
--   3) 跨表引用均声明外键；业务唯一性用 UNIQUE 索引显式表达。

-- ============================================================ 城市目录（§9.1 cities）
-- catalog_status 控制目录可检索性；status 表示房价数据覆盖状态，二者独立。
CREATE TABLE IF NOT EXISTS cities (
  city_code      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  province_code  TEXT NOT NULL,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  status         TEXT NOT NULL DEFAULT 'requestable'
                 CHECK (status IN ('active', 'limited', 'requestable', 'suspended')),
  catalog_status TEXT NOT NULL DEFAULT 'active'
                 CHECK (catalog_status IN ('active', 'pending', 'disabled')),
  -- 覆盖级别（city/district/community/listing 等，随数据源扩展不设硬校验）
  coverage_level TEXT,
  coverage_note  TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================ 公开数据源说明（§9.1 data_sources_public）
-- 只存公开说明：授权合同、密钥、个人联系方式一律不入 Public DB。
CREATE TABLE IF NOT EXISTS data_sources_public (
  source_id        TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  source_type      TEXT NOT NULL,
  official_url     TEXT,
  data_scope       TEXT,             -- 数据口径说明
  license_note_url TEXT,             -- 许可说明链接（非合同本身）
  display_scope    TEXT,             -- 可展示范围
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_verified_at TEXT
);

-- ============================================================ 数据源×城市覆盖（§9.1 source_city_coverage）
-- Connector 执行前必须验证 source 与 city 的授权覆盖。
CREATE TABLE IF NOT EXISTS source_city_coverage (
  source_id            TEXT NOT NULL
                       REFERENCES data_sources_public (source_id),
  city_code            TEXT NOT NULL REFERENCES cities (city_code),
  object_level         TEXT NOT NULL
                       CHECK (object_level IN ('city', 'district', 'community', 'listing')),
  metric_codes_json    TEXT NOT NULL DEFAULT '[]',
  authorization_status TEXT NOT NULL
                       CHECK (authorization_status IN (
                         'approved', 'approved_open', 'approved_licensed',
                         'pending_review', 'manual_only', 'suspended'
                       )),
  last_verified_at     TEXT,
  PRIMARY KEY (source_id, city_code, object_level)
);

-- ============================================================ 行政区域（§9.1 regions）
-- V1 不导入全国全量区县/小区；只导入已开通城市的必要层级。
CREATE TABLE IF NOT EXISTS regions (
  region_id    TEXT PRIMARY KEY,
  parent_id    TEXT REFERENCES regions (region_id),
  city_code    TEXT NOT NULL REFERENCES cities (city_code),
  region_code  TEXT,
  name         TEXT NOT NULL,
  level        TEXT NOT NULL
               CHECK (level IN ('district', 'county', 'township', 'block')),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  source_id    TEXT REFERENCES data_sources_public (source_id),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_regions_city_parent_name_level
  ON regions (city_code, parent_id, name, level);
CREATE INDEX IF NOT EXISTS ix_regions_region_code ON regions (region_code);
CREATE INDEX IF NOT EXISTS ix_regions_city_name   ON regions (city_code, name);

-- ============================================================ 小区（§9.1 communities）
-- address_coarse 仅粗粒度地址，不保存个人门牌。
CREATE TABLE IF NOT EXISTS communities (
  community_id    TEXT PRIMARY KEY,
  city_code       TEXT NOT NULL REFERENCES cities (city_code),
  region_id       TEXT REFERENCES regions (region_id),
  name            TEXT NOT NULL,
  alias_json      TEXT NOT NULL DEFAULT '[]',
  address_coarse  TEXT,
  block_name      TEXT,
  built_year      INTEGER,
  longitude       REAL CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
  latitude        REAL CHECK (latitude  IS NULL OR (latitude  BETWEEN -90  AND 90)),
  identity_source TEXT,
  status          TEXT NOT NULL DEFAULT 'unverified'
                  CHECK (status IN ('active', 'pending', 'unverified')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS ix_communities_region_name ON communities (region_id, name);
CREATE INDEX IF NOT EXISTS ix_communities_city_name   ON communities (city_code, name);

-- ============================================================ 观测明细（§9.1 price_observations）
-- 最小标准化来源观测；价格允许为空（空值≠0，禁止造数）。
CREATE TABLE IF NOT EXISTS price_observations (
  observation_id         TEXT PRIMARY KEY,
  source_id              TEXT NOT NULL
                         REFERENCES data_sources_public (source_id),
  object_type            TEXT NOT NULL
                         CHECK (object_type IN ('region', 'community', 'listing')),
  object_id              TEXT NOT NULL,
  property_type          TEXT CHECK (property_type IS NULL
                         OR property_type IN ('new_build', 'resale')),
  price_type             TEXT NOT NULL
                         CHECK (price_type IN (
                           'listing_ask', 'closed_transaction', 'official_index',
                           'user_reported', 'model_estimate'
                         )),
  metric_code            TEXT NOT NULL,
  price_total_fen        INTEGER,               -- 总价（人民币分），可空
  unit_price_yuan_sqm    INTEGER,               -- 单价（元/㎡），可空
  area_sqm               REAL,
  sample_count           INTEGER NOT NULL DEFAULT 1
                         CHECK (sample_count >= 0),
  stat_date              TEXT NOT NULL,
  published_at           TEXT,
  collected_at           TEXT NOT NULL DEFAULT (datetime('now')),
  quality_status         TEXT NOT NULL DEFAULT 'valid'
                         CHECK (quality_status IN (
                           'valid', 'low_sample', 'stale', 'outlier', 'rejected'
                         )),
  source_record_key_hash TEXT,                  -- 仅许可允许时保存
  payload_hash           TEXT NOT NULL,
  connector_version      TEXT
);

CREATE INDEX IF NOT EXISTS ix_price_obs_source_stat_obj
  ON price_observations (source_id, stat_date, object_id);
CREATE INDEX IF NOT EXISTS ix_price_obs_object_stat
  ON price_observations (object_type, object_id, stat_date);

-- ============================================================ 聚合快照（§9.1 price_snapshots）
-- 同一（对象, 价格类型, 指标, 统计日期）仅一条快照，重复采集幂等覆盖。
CREATE TABLE IF NOT EXISTS price_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  object_type   TEXT NOT NULL
                CHECK (object_type IN ('region', 'community', 'listing')),
  object_id     TEXT NOT NULL,
  price_type    TEXT NOT NULL
                CHECK (price_type IN (
                  'listing_ask', 'closed_transaction', 'official_index',
                  'user_reported', 'model_estimate'
                )),
  metric_code   TEXT NOT NULL,
  median        REAL,
  mean          REAL,
  p25           REAL,
  p75           REAL,
  sample_count  INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
  stat_date     TEXT NOT NULL,
  collected_at  TEXT NOT NULL DEFAULT (datetime('now')),
  source_id     TEXT REFERENCES data_sources_public (source_id),
  quality_status TEXT NOT NULL DEFAULT 'valid'
                 CHECK (quality_status IN (
                   'valid', 'low_sample', 'stale', 'outlier', 'rejected'
                 )),
  method_version TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_price_snapshots_key
  ON price_snapshots (object_type, object_id, price_type, metric_code, stat_date);
CREATE INDEX IF NOT EXISTS ix_price_snapshots_core
  ON price_snapshots (object_type, object_id, metric_code, stat_date DESC);

-- ============================================================ 挂牌价事件（§9.1 listing_price_events_public，授权数据可用时）
-- 默认不保存经纪人/业主姓名电话、精确门牌或图片。
CREATE TABLE IF NOT EXISTS listing_price_events_public (
  listing_event_id  TEXT PRIMARY KEY,
  listing_key_hash  TEXT NOT NULL,
  community_id      TEXT REFERENCES communities (community_id),
  source_id         TEXT NOT NULL
                    REFERENCES data_sources_public (source_id),
  event_type        TEXT NOT NULL,
  old_price_fen     INTEGER,
  new_price_fen     INTEGER,
  event_date        TEXT NOT NULL,
  observed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  license_scope_ref TEXT
);

CREATE INDEX IF NOT EXISTS ix_listing_events_community_date
  ON listing_price_events_public (community_id, event_date);
CREATE INDEX IF NOT EXISTS ix_listing_events_key_date
  ON listing_price_events_public (listing_key_hash, event_date);
