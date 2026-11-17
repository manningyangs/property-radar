# SPEC — TASK-10 后台前端页:用户管理 + 管理员角色与审计

负责人指令(2026-11-17):按 TASK-09 收尾建议,先实现两个"后端 API 已齐、仅缺前端页"的栏目。**纯前端消费现有 API,零后端改动。**

## 0. 依据与现状

- PRD §8.1 十项导航中 6 项"暂未开放"(AdminSidebar 既定标注);其中「用户管理」「管理员角色与审计」后端 API 已在 TASK-06A/06B 交付并经生产 API 级验证(docs/evidence/08b-t6-prod-reachability.md)。
- API 契约(唯一真源为代码,此处摘要):
  - `GET /api/v1/admin/users?q=&status=active|frozen&limit(1-100,默认20)&offset` → `{items:[{user_id,email_masked,status,email_verified,created_at,last_login_at,is_admin,watch_count}],total,limit,offset}`;q 仅精确匹配 user_id 或完整邮箱(防枚举,不做 LIKE)。
  - `PATCH /api/v1/admin/users/:id/status` body `{status:'active'|'frozen', reason(8-500)}` → `{user}`;409=冻结自己/状态相同(防自锁拍板 1)。
  - `GET /api/v1/admin/users/:id/monitoring?reason(10-500 必填)` → `{user, watches:[{watch_id,object_type,object_id,display_name_snapshot,priority,status,created_at,rules:[...]}]}`;服务端自动写审计 `admin.user.monitoring_view`。
  - `GET /api/v1/admin/audit?limit(≤200,默认50)&offset&action=&actor_user_id=&resource_type=` → `{items:[{audit_id,actor_user_id,actor_role,action,resource_type,resource_id,reason,created_at}],total,limit,offset}`(均精确筛选)。

## 1. 需求分解

- **R1 用户管理页 `/admin/users`**:搜索框(q,提示精确匹配)+ 状态 chips(全部/活跃/已冻结)+ 分页表格(列:用户 ID/脱邮邮箱/状态徽章/邮箱验证/注册时间/最近登录/管理员标记/监控数/操作)。操作=冻结/解冻(ConfirmDialog 二次确认+理由输入 8-500 前端校验;409/400 错误如实 toast)、查看监控(抽屉:理由输入 ≥10 字符才可提交,展示 watch+rules,提示"本次查看已写入审计")。`deletion_pending` 状态如实显示徽章+冷静期语义说明(注销申请由用户自助发起、冷静期后 cron 自动清除,**无管理员处理 API**——PRD §8.3"注销申请处理"记为偏差,待后续任务补 API)。
- **R2 角色与审计页 `/admin/audit`**:筛选(action/actor_user_id/resource_type 三个精确输入+提示可用值)+ 分页表格(时间/操作者/角色/动作/资源/理由)。顶部"管理员角色"说明块:角色授予仅经 bootstrap(需 BOOTSTRAP 码+MFA),在职管理员可在用户管理页按「管理员」标记查看;**无角色列表/吊销 API**——PRD §8.1 第 9 项的"角色管理"记为偏差留痕,本页为审计日志+角色现状说明。
- **R3 侧栏**:AdminSidebar 两项加 href(用户管理→/admin/users、管理员角色与审计→/admin/audit),移除对应"暂未开放"徽章;其余四项不动。
- **R4 lib/api.ts**:新增 `AdminUserItem`/`AdminUserList`/`AuditItem`/`UserMonitoring` 类型与请求函数(沿用现有 adminFetch 口径,credentials include,401/403 处理同既有页)。

## 2. 设计约束

- 页面结构/样式类沿用 `admin/quality.astro`、`admin/jobs.astro` 既有模式(AppShell+AdminSidebar slot、状态条、chips、表格、抽屉、toast、ConfirmDialog、LoadingSkeleton、空态);不引入新依赖、不新增 CSS 体系。
- 隐私红线:页面仅展示 email_masked;监控明细抽屉必须带理由且明示审计留痕(与后端一致);不新增任何 PII 展示。
- 门禁矩阵沿用:未登录 401→引导登录;非管理员/未过 MFA 403→如实提示。

## 3. 验收标准

1. 两页在本地 wrangler+astro 环境经浏览器实测:真实数据渲染、筛选/分页/冻结/解冻/监控抽屉/审计筛选全链可用,截图留证。
2. 冻结自己→409 文案如实展示;理由长度不足→前端拦截+后端 400 文案兜底。
3. 监控抽屉提交后,`GET /admin/audit?action=admin.user.monitoring_view` 可查到对应审计行(闭环实证)。
4. 四门禁:api vitest 全量回归(后端零改动应全绿)、typecheck、lint、build;collectors pytest 不受影响可跳过单独说明。
5. 侧栏徽章数从 6 减至 4;其余"暂未开放"项不受影响。

## 4. 非目标

后端任何改动(含新端点/字段);覆盖地图、目录管理、事件投递台、系统参数页;角色授予/吊销操作;PRD §8.2 总览改版。
