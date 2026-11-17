# TASK-09 checklist

## T1 URL 核验
- [x] 16 小区贝壳搜索页逐一核验（≥1s 间隔），结果与判据留痕于 beike 配置 meta
- [x] 核验表进入验收报告

## T3 来源登记
- [x] data-sources.json 新增 beike 条目（approved_licensed + 2026-11-17 裁决全文 + 边界 limitations）
- [x] 0003 public 种子：data_sources_public / source_license_state / source_city_coverage×2 / source_field_verifications / cities coverage_note（幂等）
- [x] 0003 private 种子：apr_beike_0001 审批记录（purposes=research_validation_only）

## T4 采集器
- [x] beike_community.py：白名单仅 qd.ke.com；挑战页识别不绕过；≤30 套；不存 HTML
- [x] run_beike.py：run_guard 门禁 + 批次/任务状态 + --fixture 零出网 + 不入 cron
- [x] test_beike_community.py 全绿（解析/挑战页/白名单/未知小区/回放幂等/全失败判 failed）

## T5 交叉核验
- [x] cleaning.ts：CROSS_SOURCE_MAX_DIVERGENCE=0.15、METHOD_VERSION=09-aggregate-v3
- [x] observations.ts：有效源≥2 且偏差>0.15 → 快照 outlier（median 等仍写入留痕）
- [x] admin-ops /quality/issues：snapshot 类异常聚合可见
- [x] 后台前端质量页渲染 snapshot 标签
- [x] 边界单测：14.9%→valid、15.0%→valid（严格>）、15.1%→outlier、单源不触发、有效源<2 不触发

## T6 本地验收
- [x] 0003 种子本地两库应用成功（幂等重跑无重复行）
- [x] run_beike --fixture 回放成功入库（job/batch/observation/snapshot 链路）
- [x] 双源同日偏差>15% → 快照 outlier → 后台质量异常可见
- [x] 四门禁全绿（collectors pytest / api 测试 / typecheck+lint / build）

## T7 生产
- [x] 生产两库 0003 种子 + Worker 部署 + 可达复验
- [x] 真实手工触发 run_beike 抽样：成功入库或如实 down（零绕过）

## T8 收尾
- [x] OPERATIONS 贝壳手工 SOP
- [x] 验收报告 docs/TASK-09-*.md
- [x] 记忆更新 / 三件套勾选 / commit+push+CI 全绿

## 红线复核（终检）
- [x] 代码无任何绕过验证码/登录/风控路径
- [x] beike 未注册进 cron / daily-collect workflow
- [x] fixture 为手工构造样例，仓库无真实抓取 HTML 落盘
- [x] 链家/安居客/贝壳开放平台状态未被改动
