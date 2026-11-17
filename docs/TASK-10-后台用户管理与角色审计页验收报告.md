# TASK-10 后台前端页:用户管理 + 管理员角色与审计 · 验收报告

日期：2026-11-17 ｜ Spec：`.trae/specs/admin-users-audit-pages/` ｜ 状态：**验收通过**

## 一、范围与原则

负责人批准 TASK-09 收尾建议：补建两个"后端 API 已齐、仅缺前端页"的栏目。**纯前端消费现有 API，apps/api 零改动**（git diff 证实：改动仅 `apps/web` 4 文件 + spec/报告/证据）。

## 二、交付

| 文件 | 内容 |
| --- | --- |
| `apps/web/src/pages/admin/users.astro` | 用户管理页：精确搜索（防枚举提示）、状态 chips、分页表格（脱敏邮箱/状态徽章/管理员标记/监控数）、冻结/解冻（理由 8–500 前端校验 + ConfirmDialog 二次确认 + 409/400 如实 toast）、监控明细抽屉（理由 ≥10 拦截 + "已写入审计"明示）、deletion_pending「注销冷静期」徽章+说明 |
| `apps/web/src/pages/admin/audit.astro` | 角色与审计页：action/actor/resource_type 三精确筛选 + 分页表格 + 常见取值图例 + 角色说明块（bootstrap 授予、无吊销 API 偏差留痕） |
| `apps/web/src/lib/api.ts` | +130 行：5 类型 + 4 请求函数（沿用 adminFetch 口径） |
| `apps/web/src/components/AdminSidebar.astro` | 两项加 href，「暂未开放」徽章 6→4 |

## 三、浏览器全链实测（本地 wrangler+astro，会话注入）

11/11 断言通过：

- 侧栏徽章 6→4；列表渲染真实用户
- **红线**：冻结自己 → 后端 409「不能冻结自己的账号」如实 toast（防自锁拍板 1 前端可见）
- 冻结 plain 用户 → 行徽章「已冻结」→ 解冻还原「活跃」
- 监控抽屉：短理由前端拦截 → 合规理由加载明细 + 审计提示可见
- **审计闭环实证**：`action=admin.user.monitoring_view` 筛出 2 条（含目标用户）；`admin.user.status` 4 条，理由文本可见

截图：`evidence/10-users-list.png`、`evidence/10-users-monitoring-drawer.png`、`evidence/10-audit-filtered.png`

## 四、门禁

api vitest **347 绿**（后端零改动回归）｜ typecheck 0 错 ｜ eslint+prettier 绿 ｜ build 22 页（含 /admin/users、/admin/audit）。collectors pytest 不受影响未重跑。

## 五、偏差留痕（均已写入页面/说明块）

1. PRD §8.3「注销申请处理」：后端无管理员处理端点（用户自助 + 冷静期 cron 清除），页面如实显示状态与语义，处理操作待后续补 API。
2. PRD §8.1 第 9 项「角色管理」：无角色列表/授予/吊销 API（仅 bootstrap 授予），页为审计日志 + 角色现状说明；角色操作台待后续任务。

## 六、生产

push 后 Pages 自动部署（Deploy Web workflow），`https://property-radar-web.pages.dev/admin/users`、`/admin/audit` 随新构建上线；Worker 无需重新部署（后端未动）。
