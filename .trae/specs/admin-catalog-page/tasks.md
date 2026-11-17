# TASKS — TASK-11 行政区与小区目录页

## T1 [x] API 层与侧栏
- lib/api.ts：目录相关类型 + 公开端点请求函数（cities/coverage/regions/communities-coverage/community detail+prices）
- AdminSidebar：「行政区与小区目录」加 href /admin/catalog，徽章 4→3

## T2 [x] /admin/catalog 页
- 城市选择+元信息卡+覆盖来源表；区域表格（服务端模糊筛选）；小区覆盖复查表（chips：全部/已覆盖/未覆盖/质量异常；快照徽章+quality_status；计数条）；小区搜索+详情抽屉（基础信息+最近快照）；偏差说明块（无写操作 API）

## T3 [x] 验收
- 浏览器实测全链（本地 4321，青岛真实数据）+ 截图
- 四门禁：api 回归/typecheck/lint/build

## T4 [x] 发布与收尾
- 本地 wrangler 发布 + 内容标记核验（不看状态码）
- 报告 docs/TASK-11-*.md；记忆；勾选；中文 commit/push/盯 CI
