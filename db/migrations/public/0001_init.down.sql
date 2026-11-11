-- TASK-02A：Public D1 回滚（等效重建流程的前半段）——幂等，可重复运行。
-- 顺序按外键依赖倒序；DROP TABLE 自动移除其上索引。

DROP TABLE IF EXISTS listing_price_events_public;
DROP TABLE IF EXISTS price_snapshots;
DROP TABLE IF EXISTS price_observations;
DROP TABLE IF EXISTS communities;
DROP TABLE IF EXISTS regions;
DROP TABLE IF EXISTS source_city_coverage;
DROP TABLE IF EXISTS data_sources_public;
DROP TABLE IF EXISTS cities;
