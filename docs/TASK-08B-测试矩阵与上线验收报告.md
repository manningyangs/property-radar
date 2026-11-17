# TASK-08B 测试矩阵与上线验收报告（任务书 §14）

> 日期：2026-11-17 ｜ 范围：§14.1 功能 9 项 + §14.2 数据 10 项 + §14.3 安全 8 项 + §14.4 性能 5 项，共 32 项
> 环境：本地栈（wrangler dev 8789 + astro dev 4321 + .dev.vars 五变量 + 邮件桩 18799）；生产 `property-radar-web.pages.dev` / `property-radar-api.yang1-75.workers.dev`（Worker `607ba987`）
> 对账底稿：`TASK-08B-矩阵对账表.md`；证据：`docs/evidence/08b-*`（本轮新增 20+ 件）

## 一、总体判定

**32 项矩阵：31 项 PASS，1 项 PASS（生产复验待部署，P4）。无 FAIL 遗留。**
四门禁全绿：typecheck 0 错误（api tsc×2 + astro check 55 文件）、lint（eslint + prettier）通过、test（api 341 例 20 文件 + web 全过）、build（20 页 + Worker bundle）成功。

用户报告的阻断缺陷「首页登录页无法输入邮箱」根因定位并修复：`PUBLIC_TURNSTILE_SITEKEY` 未配置触发登录表单 fail-closed（预期行为，但本地开发缺文档键）。本地以官方 always-pass 测试键打通，浏览器实测邮箱输入、发码、OTP 步进全通（`08b-t7-login-*.jpg`）。

## 二、32 项逐条结论

### 14.1 功能矩阵（T2 本地浏览器全链路 + T6 生产抽测）

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| F1 | 游客浏览区域和小区 | **PASS** | 08b-t2 游客链路 + T6 生产首页/regions/community 200 且真实数据渲染 |
| F2 | OTP 注册/登录/退出/过期/重放 | **PASS** | auth.test 19 例 + T2-A 浏览器全链路 + T7 sitekey 修复复验；生产登录 BLOCKED-PROD（§四） |
| F3 | 监控对象 增/编/暂停/删 | **PASS** | me.test（03A CRUD）+ T2-B 浏览器操作 |
| F4 | 价格目标 创建/修改/删除 | **PASS** | me.test（03B rules）+ T2-B |
| F5 | 正常触发/重复不触发/异常不触发 | **PASS** | rules-engine.test + T2-C 注入→站内事件可见；异常 400 零受理 |
| F6 | 跌破/恢复/再次跌破 re-arm | **PASS** | rules-engine 05A 五场景状态机 + T2-C 事件流复测 |
| F7 | 每日摘要/发送失败/额度耗尽 | **PASS** | digest/events-mail.test + T2-D（邮件桩演练）+ 07c-03 |
| F8 | 导出/注销/删除数据 | **PASS** | data-compliance 12 例 + T2-D 抽查 + 07b-02/03 |
| F9 | 管理员审核/暂停源/审计 | **PASS** | admin.test 22 例 + T6 生产后台 sources/jobs/quality/audit 实测（08D 会话） |

### 14.2 数据矩阵（T3 补强后）

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| D1 | 发布时间晚于统计时间（倒挂） | **PASS** | cleaning.test 六类规则逐行断言 |
| D2 | 日期倒退 | **PASS** | cleaning.test |
| D3 | 价格字段缺失/单位错误 | **PASS** | cleaning.test + internal「双价皆空 400」 |
| D4 | 样本数 0/1/4/5/9/10/19/20 全边界 | **PASS** | T3 新增 1/9/10/19/20 断言（internal.test），既有 0/4/5/20；前端 sampleTier(0)/(1) 补测 |
| D5 | 同一房源重复记录 | **PASS** | cleaning 批内去重 + internal 跨批幂等 |
| D6 | 组成变化中位数跳变 | **PASS** | T3 新增：诚实重算 30000→31500、mean 38250，不沿用旧值 |
| D7 | 同名小区映射冲突 | **PASS** | T3 新增：跨来源合并 sample_count=2/median=32000；不同对象隔离不串数 |
| D8 | 官方指数误读为元/㎡ | **PASS** | internal「index 携带金额 400 互斥」+「1500 超界 400」 |
| D9 | 挂牌价误标成交价 | **PASS** | T3 新增 ingest 侧：挂牌/成交各自独立快照互不污染；非法 price_type 400。**行为登记**：`closed_transaction` 枚举合法、被接受为独立快照（非拒绝），核验枚举约束在 admin 侧（admin.test） |
| D10 | 停用后仍进规则引擎 | **PASS** | internal suspend→403 + 07c-04 演练 |

### 14.3 安全矩阵（07A 套件 + T4 渲染侧审计）

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| S1 | 越权用他人 ID | **PASS** | security「IDOR 一律 404」+ body 带 user_id 400 |
| S2 | 未登录 /me/* | **PASS** | security/city-coverage/admin 各 401 用例 |
| S3 | 普通用户 /admin/* | **PASS** | security「角色只认库」 |
| S4 | OTP 暴力/枚举 | **PASS** | security 5 次锁定 + 字节级一致响应；T7 浏览器限频反证 |
| S5 | SSRF | **PASS** | security 3 例（展示零 fetch/内网元数据拒/固定端点） |
| S6 | 恶意 HTML/XSS | **PASS（修复后）** | T4 审计 25 innerHTML+2 href：公共页骨架+textContent、后台页 esc()；**发现并修复** admin/sources.astro 两缺口（徽章 fallback 未 esc、URL 直拼 href→`urlCell()` http(s) 白名单）。残余：后端写入侧无 scheme 校验（低优先，登记 §五-5） |
| S7 | 日志无 Token/OTP/PII | **PASS** | security 日志序列化断言 + 07a-03/04 secrets 扫描 |
| S8 | 未授权 source 强制调用 | **PASS** | internal「pending_review+合法签名→403」 |

### 14.4 性能矩阵（T5 实测）

| # | 项 | 结论 | 证据 |
| --- | --- | --- | --- |
| P1 | 360/390/430 无横向溢出 | **PASS** | 浏览器 376px 首页/登录页 scrollWidth=clientWidth（08b-t5-p1-*.jpg）+ 08c-04c/06d 既证 |
| P2 | 小区搜索分页/索引 | **PASS** | EXPLAIN：region 走 ix_communities_region_name、趋势走 ix_price_snapshots_core；name LIKE 全表 SCAN——目录规模小可接受，**规模化建议 FTS5 登记后续** |
| P3 | 趋势接口限范围/条数 | **PASS** | 既有 limit 断言复核 + T5 新增 limit=999→400 |
| P4 | 公共接口缓存策略 | **PASS（生产复验待部署）** | 原缺口：无 Cache-Control→**修复**：public 路由 `use("*")` GET 200 设 `public, max-age=60, stale-while-revalidate=300`；400/404 不带；public.test 2 新用例。生产 Worker `607ba987` 未含此版本→部署后复验 |
| P5 | Worker 轻量 | **PASS** | bundle 286KiB/gzip 69KiB；读路径纯 SELECT，无请求路径重型计算 |

## 三、T7 缺陷登记（发现→修复→复验）

| # | 发现 | 修复 | 复验 |
| --- | --- | --- | --- |
| 1 | 登录页邮箱输入禁用（用户报告） | 根因=PUBLIC_TURNSTILE_SITEKEY 未配置（fail-closed 预期）；apps/web/.env 配 always-pass 测试键（与 .dev.vars secret 配对），OPERATIONS 补文档 | 浏览器实测：输入启用→发码→OTP 步（截图） |
| 2 | /account 全演示桩（前后端未打通） | 会话 getMe、通知渠道 GET/PATCH /me/notification-preferences（失败回滚）、覆盖申请 POST /me/city-coverage-requests、退出/注销/导出真实化；api.ts 扩展 | astro check 0 错误 + API 级会话验证；生产页面复验随部署 |
| 3 | P4 公共接口无缓存头 | public.ts 中间件（见上） | public.test 200 带头/400 404 无头 |
| 4 | sources.astro 两处 XSS（T4 发现） | esc fallback + urlCell 白名单 | T8 门禁回归 |
| 5 | （环境非缺陷）本机代理 fake-IP 触发 Chromium PNA 拦截 workers.dev | 测试脚本加 --disable-features 规避 | T6 五页零控制台错误 |

## 四、上线门槛判定与 BLOCKED 清单

**判定：代码与测试层面达到「可开注册」门槛；生产开注册前必须完成下列 ①②。**

BLOCKED/待办清单（对应 OPERATIONS §7）：
1. **生产 Turnstile 正式 sitekey/secret**（08A 步骤①②）→ 解除后补生产 OTP 全链路实测；完成前登录页禁用属预期。
2. **08B 修版部署**：Worker（P4 缓存头、sources.astro 修复、/account 真实化随 Pages）+ Pages 重建；部署后复验 P4 响应头与生产 /account。
3. 生产 `admin_roles` 管理员已建（08D：ya***@126.com，MFA enrolled+confirmed），bootstrap code 撤销状态待确认。
4. 占位邮箱替换（07B 遗留）。
5. 后端 URL 写入侧 scheme 校验（低优先，渲染侧已阻断执行路径）。
6. Dashboard Spend Alerts 设置。

## 五、证据索引（本轮 08b-*）

- T1 对账表：`docs/TASK-08B-矩阵对账表.md`
- T2：`08b-01-homepage/regions.jpg`、`08b-02-otp-step/account-logged-in/post-logout.jpg`、`08b-03-watch-*.jpg`、`08b-04-rule-*.jpg`、`08b-events-target-triggered.jpg`、`08b-08-export-sample.json`（功能矩阵浏览器全链路）
- T3：`internal.test.ts`/`market.test.ts` 新用例（代码即证据）
- T4：`08b-t4-s6-render-audit.md`
- T5：`08b-t5-p1-*.jpg`、EXPLAIN 记录、`public.test.ts` P3/P4 用例
- T6：`08b-t6-prod-reachability.md` + `08b-t6-prod-*.png` 5 张
- T7：`08b-t7-login-form-enabled.jpg`、`08b-t7-login-otp-step.jpg`
- T8：本报告 §一 四门禁记录
