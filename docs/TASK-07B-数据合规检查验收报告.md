# TASK-07B 数据合规检查验收报告

**提交**: `01b5bcc` · **CI**: `43819553896` success · **日期**: 2026-11-16

---

## 1. 任务范围与拍板决策

任务书 §7 行 1382–1384：逐数据源复核许可范围；逐页面核对数据来源展示；检查隐私政策、用户协议、数据导出删除、保留期限和第三方处理者说明。

| # | 拍板项 | 决策 |
|---|---|---|
| 1 | 修复范围 | **全部落地**（/privacy、/terms、/me/export、/me/delete-account、account.astro 接线） |
| 2 | 注销冷静期 | **7 天 + 到期硬删**（`DELETION_COOLDOWN_DAYS=7`，cron 每日 purge） |
| 3 | 数据导出 | **JSON 单文件**（13 键，`Content-Disposition: attachment`） |
| 4 | 第三方处理者 | **占位 + 上线前替换**（列入 07C） |

---

## 2. 数据源许可复核表（10 源，`config/sources/data-sources.json`）

| source_code | 名称 | 状态 | 许可依据 | 复核结论 |
|---|---|---|---|---|
| `stats_nbs_70city` | 国家统计局 70 城指数 | `approved_open` | 官网条款允许下载/使用，注明出处 | ✅ 合规 |
| `sz_zjj_secondhand_daily` | 深圳住建局二手房成交日统计 | `approved_open` | 平台无条件开放，须注明来源 | ✅ 合规（但无价格字段，仅作旁证） |
| `qd_stats_price_index` | 青岛市统计局住宅价格指数 | `approved_open` | 官网免费公开发布 | ✅ 合规（TASK-04C 已接入） |
| `qd_zjj_trade_platform` | 青岛住建局住房交易监管平台 | `manual_only` | 政务信息，无正式开放许可条款 | ⚠️ 保持人工查看，自动采集前须确认许可 |
| `hz_open_data` | 杭州市数据开放平台 | `pending_review` | 分无条件/有条件，具体条款待确认 | ⚠️ 许可确认前不启用自动采集 |
| `beike_open_platform` | 贝壳开放平台 | `pending_review` | 服务协议禁机器人；开放平台商务洽谈制 | ⚠️ 须书面授权 |
| `lianjia` | 链家 | `manual_only` | 无独立公开授权 | ✅ 仅用户手工录入+跳转 |
| `anjuke` | 安居客 | `manual_only` | robots.txt 首行禁自动化；用户协议第 8 条禁抓取 | ✅ 保持 manual_only |
| `fang_com` | 房天下 | `approved_licensed` | 负责人 2026-11-12 裁决（TASK-04D）：仅验证用途、公开列表页、不存原始 HTML、不入 cron | ✅ 风险留痕（.trae/specs/community-listing-pipeline/spec.md §0-1） |
| `user_manual_record` | 用户手工录入/核验 | `approved_open` | PRD §5.4：用户保存来源/URL/备注/手工价格，系统不自动抓取 | ✅ 合规 |

**结论**：10 源许可登记完备，状态机与审批记录一致；无超范围自动采集。

---

## 3. 逐页面来源展示核对

| 页面 | 路由 | 来源组件 | 展示内容 | 生产空态策略 |
|---|---|---|---|---|
| 首页 | `/` | `SourceAttribution`（数据说明 section） | 指标口径 / 来源 / 统计日期 / 采集时间 / 质量等级 | 无 demo 数据时不展示价格区段（不虚构） |
| 区域详情 | `/region?id=` | `SourceAttribution`（demo 分支） | 同上 | 空态 `EmptyState` "暂未覆盖，可提交覆盖申请" |
| 小区详情 | `/community?id=` | `SourceAttribution`（demo 分支） | 同上 | 空态 `EmptyState` "暂未覆盖" |
| 简报 | `/briefing` | 静态口径声明 `.brief-source` | "口径：挂牌参考…数据来源：演示数据源A/B…" | 空态 `EmptyState` "简报由监控事件与市场数据生成" |
| 事件中心 | `/events` | 无独立组件（事件本身含来源） | 事件列表含来源字段 | 空态 "暂无事件" |

**合规判定**：
- 有数据时：所有行情页面均展示 `SourceAttribution`（指标口径 + 来源 + 统计日期 + 采集时间 + 质量等级），截图证据 `docs/evidence/07b-05-{community,region,index,events}-source.png`。
- 无数据时：页面降级为 `EmptyState` 空态，**绝不虚构价格**（PRD §4.4 / TASK-04D 红线）。
- 生产构建（无 `PUBLIC_DEMO_DATA=1`）：所有行情页面均为空态——与当前阶段"青岛 16 小区已核验但无正式接入数据源"一致，合规。

---

## 4. 隐私政策 / 用户协议

| 页面 | 路由 | 状态 | 说明 |
|---|---|---|---|
| 隐私政策 | `/privacy` | ✅ 已上线 | 九节全文：信息收集、使用、共享、存储、安全、用户权利、未成年人、变更、联系；处理者信息标注占位（`[上线前替换]`） |
| 用户协议 | `/terms` | ✅ 已上线 | 八节：服务说明、用户义务、知识产权、免责声明、违约处理、协议修改、法律适用、联系方式 |
| 账户页接线 | `/account` | ✅ 已上线 | 隐私政策/用户协议链接 + 数据导出按钮 + 注销冷静期文案与真实调用 |

**证据**: `docs/evidence/07b-04-privacy.png`、`07b-04-terms.png`

---

## 5. 数据导出 / 删除

### 5.1 数据导出

- **端点**: `GET /me/export`
- **响应**: JSON 单文件 13 键：`schema_version` / `exported_at` / `account` / `watch_items` / `watch_rules` / `watch_rule_settings` / `watch_item_groups` / `alert_events` / `notification_preferences` / `push_subscriptions` / `city_coverage_requests` / `user_cities` / `user_consents`
- **下载**: `Content-Disposition: attachment; filename="property-radar-export-<YYYY-MM-DD>.json"`
- **权限**: 强制登录，按 user_id 隔离
- **实测**: 登录 → 造数（watch/rule/prefs）→ 账户页点"导出" → 下载 toast 成功 → JSON 含 13 键（含 rule 绑定三元组）
- **证据**: `07b-02-account-export.png`、`07b-02-export-sample.json`

### 5.2 账户注销

- **端点**: `POST /me/delete-account`
- **校验**: `confirm: true` 枚举；管理员 403；已删除 404
- **冷静期**: `DELETION_COOLDOWN_DAYS=7`，写 `deletion_requested_at`
- **撤销**: 冷静期内重新登录（`POST /auth/verify-code`）自动复位 `deletion_requested_at=null`，响应 `deletion_cancelled: true`
- **到期硬删**: `purgeExpiredDeletions(db)` cron 每日执行，逐表删除个人数据（含 `admin_roles`/`mfa` 残留、`email_otps` 按邮箱），**保留** `audit_logs`/`email_send_ledger`/`ingest_*`（合规追责）
- **会话**: 注销即吊销全部会话（`sessions` 表 user_id 行删除）
- **实测**: 注销 toast → 旧 token 401 → 重登录 `deletion_cancelled=true` → D1 核验 `{"status":"active","deletion_requested_at":null,"live_sessions":1}`
- **证据**: `07b-03-delete-toast.png`、`07b-03-cancelled.png`、`07b-03-e2e-log.txt`

---

## 6. 保留期限清单

| 数据类型 | 保留策略 | 实现位置 |
|---|---|---|
| 用户账户 | 注销冷静期 7 天，到期硬删 | `apps/api/src/deletion.ts` `DELETION_COOLDOWN_DAYS=7` |
| 会话 | 注销即吊销；无独立过期（依赖 cookie 生命周期） | `deletion.ts` 逐用户删除 sessions |
| 邮件 OTP | 短期有效；注销时按邮箱清除 | `deletion.ts` `email_otps WHERE email_normalized=?` |
| 审计日志 | **永久保留**（合规追责，不设外键） | `deletion.ts` 明确保留；`audit_logs` 表注释 |
| 邮件投递台账 | **永久保留** | `deletion.ts` 保留 |
| 采集批次/Nonce | **永久保留** | `deletion.ts` 保留 |
| 推送订阅 | 60 天未活跃自动清理 | `apps/api/src/index.ts` CRON_DAILY_DIGEST 分支 |
| 数据源审批历史 | **永久保留**（append-only） | `source_approvals` 表设计；`admin-sources.test.ts` 断言 |
| 数据源数据 | 按审批 `retention_period`（180d/90d） | `source_approvals.retention_period` |
| 价格观测 | 按数据源审批保留期 | `price_observations` 关联 source_id |

---

## 7. 第三方处理者

| 处理者 | 服务 | 用途 | 数据流向 | 备注 |
|---|---|---|---|---|
| Cloudflare | Workers 运行时 | API 托管 | 请求经 CF 边缘 | 无出站限制评估（07C） |
| Cloudflare | D1 | 私有/公共数据库 | 数据驻留 CF 区域 | 无跨境专业核验（07C） |
| Cloudflare | Turnstile | 人机验证 | IP/UA 摘要 → CF siteverify | 不存储验证结果 |
| Google Apps Script | 邮件网关（`APPS_SCRIPT_WEB_APP_URL`） | OTP / 每日摘要 / 事件推送发信 | 收件邮箱 + 模板参数 → 网关（HMAC-SHA256 签名）→ 用户邮箱 | 仅传邮箱与内容，不传密码/全量档案；发信台账本地留存 |

**隐私政策占位**: `/privacy` 处理者章节标注 `[上线前替换]`，列入 07C 待办。

---

## 8. 测试与门禁

| 门禁 | 结果 |
|---|---|
| typecheck | ✅ 0 errors（api/web/shared/migrations） |
| lint | ✅ eslint + prettier |
| test | ✅ api 328 + shared 18 + migrations 27 |
| build | ✅ 18 页 |
| CI | ✅ `43819553896` success |

**新增测试**: `apps/api/src/data-compliance.test.ts` 10 用例（许可/来源展示/导出/注销/冷静期/硬删/保留/第三方）；`migrations/src/index.test.ts` 增 0016 断言。

---

## 9. 证据清单

| 文件 | 说明 |
|---|---|
| `07b-01-testrun.txt` | test 全绿输出 |
| `07b-02-account-export.png` | 账户页导出 toast + 政策按钮 |
| `07b-02-export-sample.json` | 导出 JSON 样本（13 键） |
| `07b-03-cancelled.png` | 重登录 `deletion_cancelled=true` |
| `07b-03-delete-toast.png` | 注销 toast |
| `07b-03-e2e-log.txt` | E2E 日志 |
| `07b-04-privacy.png` | 隐私政策页面 |
| `07b-04-terms.png` | 用户协议页面 |
| `07b-05-community-source.png` | 小区详情数据说明（demo） |
| `07b-05-region-source.png` | 区域详情数据说明（demo） |
| `07b-05-index-source.png` | 首页数据说明（demo） |
| `07b-05-events-source.png` | 事件中心（demo） |

---

## 10. 07C 待办

| # | 待办 | 说明 |
|---|---|---|
| 1 | 隐私政策处理者占位替换 | 确认邮件网关供应商（Resend/其他），更新 `/privacy` 处理者章节 |
| 2 | 跨境数据传输专业核验 | Cloudflare D1/Workers 数据驻留区域与 GDPR/个保法跨境条款 |
| 3 | Cloudflare 出站限制评估 | Workers 出站请求限制（Turnstile siteverify 已遇沙箱拦截，生产环境需确认） |
| 4 | 生产环境 Turnstile 密钥轮换 | 沙箱测试密钥 → 生产密钥 |
| 5 | 隐私政策法律审阅 | 建议上线前由法律顾问审阅全文 |

---

**验收结论**: TASK-07B 全部检查项已落地并通过实测，证据完备。07C 待办为上线前合规收尾，不影响本任务验收。
