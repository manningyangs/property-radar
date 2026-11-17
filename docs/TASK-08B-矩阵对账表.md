# TASK-08B §14 测试矩阵对账表（T1 产出，验收报告附录）

> 图例：✅=既有用例直接覆盖 | 🟡=部分覆盖需补断言 | 🧪=需浏览器/实测（无单测形态） | 缺口列 = 08B 需新增的动作

## 14.1 功能矩阵（9 项）

| # | 矩阵项 | 现有覆盖 | 缺口 → 08B 动作 |
| --- | --- | --- | --- |
| F1 | 游客浏览区域和小区 | public.test.ts（/public/* 全端点）+ 08c-01/03/05 生产证据 | 🧪 本地浏览器复测（T2-A） |
| F2 | OTP 注册/登录/退出/过期/重放 | auth.test.ts 19 例（过期 401、单次使用重放 401、5 次锁定、logout 撤销、限频、配额） | 🧪 浏览器全链路（T2-A） |
| F3 | 监控对象 增/编/暂停/删 | me.test.ts（03A CRUD 全量） | 🧪 浏览器操作（T2-B） |
| F4 | 价格目标 创建/修改/删除 | me.test.ts（03B rules CRUD） | 🧪 浏览器操作（T2-B） |
| F5 | 正常触发/重复不触发/异常不触发 | rules-engine.test.ts + internal.test.ts（异常 400 零受理、幂等 duplicate） | 🧪 注入数据→站内事件可见（T2-C） |
| F6 | 跌破/恢复/再次跌破 re-arm | rules-engine.test.ts 05A 五场景状态机 | 🧪 浏览器事件流复测（T2-C） |
| F7 | 每日摘要/发送失败/额度耗尽 | digest.test.ts + events-mail.test.ts（失败恰 2 次、quota_deferred）+ auth.test.ts（硬上限）+ 07c-03 演练 | 🧪 账户页触发+降级可见（T2-D） |
| F8 | 导出/注销/删除数据 | data-compliance.test.ts 12 例 + 07b-02/03 浏览器 e2e 证据 | ✅ 基本已覆盖，T2-D 抽查 |
| F9 | 管理员审核/暂停源/审计 | admin.test.ts 22 例 + admin-sources + 06c/07c-04 浏览器证据 | ✅ 已覆盖，T6 生产后台复测 |

## 14.2 数据矩阵（10 项）

| # | 矩阵项 | 现有覆盖 | 缺口 |
| --- | --- | --- | --- |
| D1 | 来源发布时间晚于统计时间 | cleaning.test.ts 六类规则逐行断言（04E spec R4 表） | T3 确认含倒挂行 |
| D2 | 日期倒退 | cleaning.test.ts"日期倒退" | ✅ |
| D3 | 价格字段缺失/单位错误 | cleaning.test.ts"缺字段"+ internal"双价皆空 400" | ✅ |
| D4 | 样本数 0/1/4/5/9/10/19/20 | cleaning 4→5；internal <5 low_sample；web market.test sampleTier(20/10/5) | 🟡 T3 补 0/1/9/10/19/20 全边界断言 |
| D5 | 同一房源重复记录 | cleaning"批内×2→1 行"+ internal"跨批幂等" | ✅ |
| D6 | 组成变化中位数跳变 | 🟡 04E 有 jump 规则待确认 | T3 查 cleaning.ts 补缺 |
| D7 | 同名小区映射冲突 | 🟡 待确认 | T3 查 04E 映射逻辑补缺 |
| D8 | 官方指数误读为元/㎡ | internal"index 携带金额 400 互斥"+"1500 超界 400" | ✅ |
| D9 | 挂牌价误标成交价 | admin.test"price_type 不在核验枚举→400" | 🟡 T3 补 ingest 侧断言 |
| D10 | 停用后仍进规则引擎 | internal"suspend→下一批 403"+ 07c-04 演练 | ✅ |

## 14.3 安全矩阵（8 项，security.test.ts 12 组全映射）

| # | 矩阵项 | 现有覆盖 | 缺口 |
| --- | --- | --- | --- |
| S1 | 越权用他人 ID | security"IDOR：B 访问 A 一律 404"+ body 带 user_id 400 | ✅ |
| S2 | 未登录 /me/* | security + city-coverage + admin 各套件 401 用例 | ✅ |
| S3 | 普通用户 /admin/* | security"伪装参数/头无效（角色只认库）" | ✅ |
| S4 | OTP 暴力/枚举 | security"5 次锁死后正确码也拒"+"响应字节级一致" | ✅ |
| S5 | SSRF | security 3 例（展示 URL 零 fetch、推送 endpoint 拒内网/元数据、固定 env 端点） | ✅ |
| S6 | 恶意 HTML/XSS | security"存储回读原样文本恒 JSON" | 🟡 **渲染侧缺口**：08C 前端 innerHTML 注入点是否转义用户可控字段（小区名/区域名）→ T4 补 |
| S7 | 日志无 Token/OTP/PII | security"访问日志序列化不含 cookie 值/OTP/哨兵"+ 07a-03/04 secrets 扫描 | ✅ |
| S8 | 未授权 source 强制调用 | internal"pending_review+合法签名→403 source_not_approved" | ✅ |

## 14.4 性能矩阵（5 项）

| # | 矩阵项 | 现有覆盖 | 缺口 |
| --- | --- | --- | --- |
| P1 | 360/390/430 无溢出 | 08c-04c(390 本地)+06d(1024) | 🧪 T5 三视口实测关键页 |
| P2 | 小区搜索分页/索引 | packages/migrations 索引断言 | 🧪 T5 EXPLAIN QUERY PLAN |
| P3 | 趋势接口限范围/条数 | public.test prices limit | 🟡 T5 断言复核 |
| P4 | 公共接口缓存策略 | 无 | 🧪 T5 响应头检查（缺口，可能需补 Cache-Control） |
| P5 | Worker 轻量（10ms 免费档） | 无 | 🧪 T5 bundle 体积+路径核查 |

## 证据资产（docs/evidence 55 件）

06C×5、06D×8、07A×4、07B×10、07C×8、08A×1、08C×13、08D×2 —— 矩阵结论可直接引用。

## 08B 净缺口汇总（执行序）

1. **T2 浏览器 e2e**：F1–F7（F8/F9 抽查）——最大工作量，分 A/B/C/D 四组
2. **T3 补断言**：D4 全边界、D6/D7 确认后补缺、D9 ingest 侧
3. **T4 补断言**：S6 前端渲染转义（08C innerHTML 注入点审计）
4. **T5 实测**：P1–P5（P4 若确无缓存头，属 FAIL 候选→T7 最小修复）
