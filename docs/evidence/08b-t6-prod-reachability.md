# 08B-T6：生产可达实测（游客抽测 + 管理后台 08D 会话全模块）

> 时间：2026-11-17；生产 Worker Version `607ba987`（08C 部署，`wrangler deployments list` 末条）；
> 前端 `https://property-radar-web.pages.dev`；API `https://property-radar-api.yang1-75.workers.dev`。
> 后台会话：08D 管理员 `ya***@126.com`（pr_session 注入 `.yang1-75.workers.dev`，SameSite=None; Secure; HttpOnly），
> `GET /admin/mfa/status` → `{"enrolled":true,"confirmed":true,"session_verified":true}`。

## 1. 游客关键页抽测（curl + 截图）

| 页面 | 结果 |
| --- | --- |
| `/`（390 视口截图） | 200；真实生产数据：已接入 1 城市、累计观测样本 37、小区卡（浮山后四区 30,000 元/㎡ 等）带口径/来源/样本量；未登录事件区诚实引导，零 `/me/*` 噪音（R8 复核） |
| `/regions/` | 200（trailing-slash 308→200，Astro 目录格式） |
| `/community?id=qingchuan-huayuan` | 200 |
| `/login/` | 200（页面可达；表单禁用属预期 fail-closed，见 §4） |
| `GET /api/v1/public/regions` | 200 |

证据：`08b-t6-prod-home-guest.png`。

## 2. 管理后台全模块（08D 会话实测）

API 六端点 curl 全 200 且含真实数据；页面级 Playwright+Edge 无头注入会话截图，控制台零错误：

| 模块 | API | UI 截图 | 内容核验 |
| --- | --- | --- | --- |
| overview | `/admin/overview` 200 | `08b-t6-prod-admin-overview.png` | 任务成功率 80.0%、来源许可分布（授权已批准×1/公开已批准×1）、来源异常 1 |
| sources | `/admin/sources` 200 | `08b-t6-prod-admin-sources.png` | 房天下=故障/公开已批准、青岛统计局指数=正常；到期/覆盖/最近成功采集齐全 |
| jobs | `/admin/jobs` 200 | `08b-t6-prod-admin-jobs.png` | 10 行任务、状态徽章、错误码（upstream_500 / all_communities_failed）、分页 |
| quality | `/admin/quality/issues` 200 | `08b-t6-prod-admin-quality.png` | 4 条异常（任务失败×2/来源健康×1/观测异常×1），locator 定位要素非空（§8.6 验收一复现） |
| users | `/admin/users` 200（email_masked 脱敏） | — | 侧栏「用户管理」标注暂未开放（06B 范围），API 级验证 |
| audit | `/admin/audit` 200（当前 0 行，诚实空态） | — | 侧栏「管理员角色与审计」暂未开放，API 级验证 |

F9（管理员审核/暂停源/审计）复测并入：sources 页审批状态列 + audit 端点可达即生产侧复核，操作矩阵由 `admin.test.ts` 22 例覆盖（T1 对账表 ✅）。

## 3. 口径说明（非缺陷）

overview「已覆盖小区数 0 / 今日有效快照 0 / 尚无有效数据」为**当日窗口**指标；公共页展示**最新快照**（11-13 数据）——两者口径不同且各自诚实，与 PRD「不以其它对象数字填充」一致。

## 4. BLOCKED-PROD 登记（登录相关，对应上线清单 08A 步骤①②）

- 生产 Turnstile 为测试/未配置正式键 → 登录页保持禁用（fail-closed 预期行为）；OTP 全链路生产实测不可做，本地已由 T2/T7 覆盖。
- 上线前清单第 4 项（正式 sitekey）完成后方可解除。

## 5. 测试环境发现（登记，非产品缺陷）

本机代理 fake-IP 把 `*.workers.dev` 解析进本地地址空间，Chromium 私有网络访问（PNA/LNA）拦截 pages.dev→workers.dev 的 fetch，报「blocked by CORS policy: Permission was denied for this request to access the `local` address space」。
规避：Edge 启动参数 `--disable-features=BlockInsecurePrivateNetworkRequests,LocalNetworkAccessChecks`（curl 不受影响）。真实用户网络（DNS 返回公网 IP）不会出现此拦截；08C 生产浏览器链路 PASS 亦证。

## 6. 待部署复验项

生产 Worker `607ba987` 不含 08B 修复（P4 Cache-Control、/account 真实化、sources.astro URL 白名单）——四门禁全绿后随 09 部署，部署后复验：公共 GET 响应头、生产 /account 会话态、后台 sources 抽屉链接渲染。

## 结论

T6：**PASS**（游客 + 后台 6 模块生产可达，全部真实数据渲染）；登录项 BLOCKED-PROD 维持登记。
