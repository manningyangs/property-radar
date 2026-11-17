# SPEC — TASK-11 后台前端页:行政区与小区目录(只读)

负责人批准(2026-11-17):按 TASK-10 模式实现「行政区与小区目录」。**纯前端消费既有公开端点,零后端改动**;目录管理操作(编辑/审核/启停)无 admin API——记偏差留痕,本页为只读浏览+覆盖复查。

## 0. API 契约(唯一真源 apps/api/src/routes/public.ts,均为无鉴权公开端点)

- `GET /public/cities?q=&status=&limit` → `{items:[{city_code,name,province_code,status,catalog_status,...}],count}`(默认仅 catalog_status=active)
- `GET /public/cities/:code/coverage` → `{city:{city_code,name,province_code,status,catalog_status,coverage_level,coverage_note,updated_at}, coverage:[{source_id,object_level,metric_codes_json,authorization_status,last_verified_at}]}`;404=城市不存在
- `GET /public/regions?city_code=&q=&limit` → `{items:[{region_id,parent_id,city_code,region_code,name,level,is_active,updated_at}],count}`(q 为 LIKE 服务端模糊)
- `GET /public/communities/coverage?city_code=` → `{city_code,items:[{community_id,name,district,snapshot:{source_id,price_type,metric_code,sample_count,stat_date,collected_at,quality_status}|null}],count}`(LIMIT 200;snapshot=null 即未覆盖,不造数)
- `GET /public/communities?region_id=&q=&limit` → `{items:[{community_id,city_code,region_id,name,block_name,built_year,status,updated_at}],count}`
- `GET /public/communities/:id` → 单对象 `{community_id,city_code,region_id,name,alias_json,address_coarse,block_name,built_year,longitude,latitude,status,updated_at}`
- `GET /public/communities/:id/prices` → 快照历史列表

## 1. 需求分解

- **R1 城市层**:城市选择(下拉或 chips,来自 /cities)+ 城市元信息卡(status/catalog_status/coverage_level/coverage_note)+ 覆盖来源表(该城市授权来源:source_id/object_level/authorization_status/last_verified_at)。
- **R2 区域层**:区域表格(region_id/name/level/region_code/updated_at),名称模糊筛选(服务端 q)。
- **R3 小区覆盖复查表**(核心):/communities/coverage 逐小区——已覆盖(快照徽章+来源+样本数+stat_date+quality_status 徽章,含 outlier danger)/未覆盖(如实灰徽章);chips 筛选(全部/已覆盖/未覆盖/质量异常);计数条(共 N,已覆盖 M)。
- **R4 小区搜索+详情抽屉**:搜索框(服务端 LIKE)+ 点击行开抽屉(/communities/:id 基础信息 + /:id/prices 最近快照列表)。
- **R5 集成**:AdminSidebar「行政区与小区目录」→href /admin/catalog(徽章 4→3);lib/api.ts 追加类型与函数(公开端点无鉴权,沿用现有 public 请求口径)。

## 2. 约束

- 沿用 quality/jobs/users 页模式(AppShell+AdminSidebar slot、chips、表格、抽屉、toast、空态诚实);无新依赖、无全局样式改动;后台页仍要求管理员门禁进入(页面壳与既有 admin 页一致,数据本身公开)。
- 偏差留痕写入页内说明块:目录编辑/审核/启停无 admin API,待后续任务;覆盖复查数据上限 200 小区/城市(与端点一致)。

## 3. 验收标准

1. 本地浏览器实测:城市切换(青岛真实数据)、区域筛选、覆盖表徽章正确(含 outlier)、小区详情抽屉、chips 筛选;截图入 evidence。
2. 四门禁:api vitest 回归(后端零改动)/typecheck/lint/build。
3. **生产发布走本地通道**(教训):`PUBLIC_API_BASE=https://property-radar-api.yang1-75.workers.dev/api/v1 pnpm --filter @property-radar/web build` → `npx wrangler pages deploy apps/web/dist --project-name property-radar-web`;**内容标记核验**(curl 拉 /admin/catalog/ 查专属 data-* 标记,不看状态码——SPA 兜底会假 200)。
4. 中文 commit/push、CI 全绿;报告 docs/TASK-11-*.md;记忆与三件套勾选。

## 4. 非目标

后端改动;目录管理写操作;地图可视化(属「数据覆盖地图」栏目);其余三项暂未开放栏目。
