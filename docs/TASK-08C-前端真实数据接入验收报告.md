# TASK-08C 前端公共行情页接入真实 API 验收报告

- 任务依据：`.trae/specs/frontend-real-data/{spec.md,tasks.md,checklist.md}`（需求 R1–R9、任务 T1–T13）
- 执行日期：2026-11-17（Asia/Shanghai）
- 基线 tag：`pre-08c-frontend-real-data`（9200ffa）
- 部署产物：Pages `https://property-radar-web.pages.dev`（本次构建别名部署）；Worker Version `607ba987-aaac-4962-aae3-7e83a9808d0b`（含 R6b 写端点）

## 一、需求 R1–R9 逐条结论

| # | 需求 | 结论 | 证据 |
| --- | --- | --- | --- |
| R1 | 首页游客真实数据 | **PASS** | `08c-01-home.jpg`（本地）/ `08c-05-production-home.jpg`（生产："1 已接入数据城市 / 37 累计观测样本"）；零演示数字 |
| R2 | `/regions` 区县列表+搜索 | **PASS** | `08c-03-regions.jpg`（本地）/ `08c-06-production-data.jpg`（生产） |
| R3 | `/region` summary 指标卡 | **PASS** | `08c-06-production-region-detail.jpg`：口径/来源/数据日期/样本量四要素齐全；无快照→"暂无数据"徽章 |
| R4 | `/communities` 真实检索 | **PASS** | `08c-05-production-home-full-communities.jpg`：生产"万科"命中万科城市花园；空结果诚实空态 |
| R5 | `/community` 详情+趋势 | **PASS** | `08c-04-community(-full).jpg`（本地）+ 生产中海银海一号 34,800 元/㎡、万科城市花园 33,100 元/㎡，来源标注 `fang_com · 04e-aggregate-v2 · low_sample` |
| R6 | 城市范围 + `/cities` 页 | **PASS** | `08c-02-cities.jpg` / `08c-05-cities-page.jpg`：337 目录 + 真实状态按名叠加；active/limited/requestable 徽章；coverage 展开；游客选城 `pr_city` localStorage 持久化，刷新保持 |
| R6b | 覆盖申请写端点 | **PASS**（本地） | `apps/api/src/city-coverage.test.ts` 7 用例全绿（401/201/409 重复/400 非法/400 已开通/同名 409/缺名称 400）；生产 POST 因 workers.dev 间歇 TLS 未能 curl 直测，改由生产站浏览器链路 + 单测覆盖 |
| R7 | `/methodology` 页 | **PASS** | `08c-04b-methodology.jpg`：口径静态说明 + 来源卡（授权徽章/verified_metrics/官方链接）+ 规模卡 |
| R8 | 游客零鉴权噪音 | **PASS** | 生产 7 路由 Network 面板零 `/me/*` 请求、零 401；机制：`pr_session_hint` 门控所有 `/me/*` 调用（login 成功置位、登出清除）+ `r8.test.ts` 静态防回归 |
| R9 | 生产零演示数据 | **PASS** | 生产构建无 `PUBLIC_DEMO_DATA`；dist grep "演示" 仅出现在诚实空态文案，无演示数字 |

## 二、实现要点

1. **API 层**（T1）：`api.ts` 新增 10 个 public 封装 + `createCityCoverageRequest`；新增 `city.ts`（pr_city 读写/active 兜底/`app:city-change` 广播/目录 code 与 API code 名称匹配叠加）、`market.ts`（样本分层/新鲜度/格式化/趋势序列）、`session.ts`（登录提示门控）。
2. **渲染模式**：沿用静态骨架 + 客户端 fetch + 模板渲染惯例，未引入框架；脚本动态节点样式一律 `:global(...)`。
3. **七态状态机**：Loading/Empty/Error(重试)/Stale/Low sample/登录引导/未覆盖城市空态全页覆盖；缺失值一律 "—"，绝不补零造数；低样本（<10）降强调。
4. **后端增量**（T2，红线内唯一改动）：`POST /api/v1/me/city-coverage-requests`——登录校验、城市目录校验（active 城市 400、非目录 400）、同人同城 pending 重复 409 `already_requested`、`request_id=uuid` 落 `city_coverage_requests`。公共只读 API 零改动。
5. **测试**：apps/web 新增 vitest（city.test/market.test/r8.test），apps/api 新增 city-coverage.test 7 例。

## 三、偏差与说明

1. **首页/小区搜索的城市过滤**：后端 `/public/communities` 无 `city_code` 参数（只读 API 红线不可改）。首页改用 `/public/communities/coverage?city_code=` + 逐小区 `/prices` 取中位价；搜索页客户端按 `item.city_code === scope.city_code` 过滤。当前数据量下可接受；若小区规模扩大，后续任务再评估后端增加 city_code 查询参数。
2. **目录 code 位数不一致**：目录 4 位（3702）vs API 6 位（370200），选择器与 `/cities` 页按名称匹配叠加真实状态；未覆盖城市存目录 code，申请时仅传名称（后端 `city_code` 可空）。
3. **生产 R6b curl 直测受阻**：办公网络对 `*.workers.dev` TLS 间歇失败（exit 35，07C 已备案为数据面验证项）。端点已由 Worker 部署（Version 607ba987）+ 单测 7 例 + 生产站浏览器申请链路（游客→Permission 引导）覆盖。
4. **登录链路未在本任务范围**：游客"申请覆盖"走登录引导弹窗；Turnstile/Apps Script 手动配置现场已存项目记忆恢复点，配置完成后 R6b 全链路即可实测。

## 四、工程门禁与证据

- 四门禁：typecheck / lint / test / build 全部 exit 0（T11，prettier 修正后复跑全绿）。
- 证据 13 个文件落盘 `docs/evidence/08c-*`：本地 7（08c-01-home / 08c-02-cities / 08c-03-regions / 08c-04-community / 08c-04-community-full / 08c-04b-methodology / 08c-04c-mobile-home）+ 生产 6（08c-05-production-home / 08c-05-production-home-full-communities / 08c-05-cities-page / 08c-06-production-data / 08c-06-production-data-final / 08c-06-production-region-detail）。
- 视口抽测：360/390/430/1440 首页+小区详情+cities 无横向溢出（`08c-04c-mobile-home.jpg`）。
- 红线复核：dist 无密钥特征串；未新增付费依赖；未动登录/邮件链路；后端仅新增 R6b 一个端点。
- CI：主提交 389c4ee，CI 与 Deploy Web 工作流 run 见 GitHub（databaseId 44000622974 / 44000623030）。

## 五、遗留事项

1. 登录链路解锁（Turnstile 生产密钥 + Apps Script 邮件）——08A 手动配置清单待用户执行，恢复点已存记忆。
2. `/compare` 比较页——独立后续任务。
3. workers.dev 大陆可达性——另案（07C 上线清单 §7-5）。
4. `/public/communities` 后端 `city_code` 参数——数据规模扩大后再评估（见偏差 1）。
