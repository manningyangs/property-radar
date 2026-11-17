# CHECKLIST — TASK-11

## T1
- [x] api.ts 类型/函数齐（公开端点口径，无鉴权）
- [x] 侧栏徽章 4→3，其余项不动

## T2
- [x] 城市切换真实数据；元信息卡+覆盖来源表渲染
- [x] 区域表格+服务端模糊筛选生效
- [x] 覆盖复查表：已覆盖/未覆盖/outlier 徽章正确；chips 四类筛选；计数条（共 N 已覆盖 M）
- [x] 小区搜索可用；详情抽屉=基础信息+最近快照
- [x] 偏差说明块（无写操作 API/200 上限）；空态诚实

## T3
- [x] 浏览器实测全链+截图入 evidence/11-*
- [x] api vitest 全绿 / typecheck 0 错 / lint 绿 / build 绿（页数+1）

## T4
- [x] 本地 wrangler 发布；/admin/catalog/ 内容标记核验通过
- [x] 报告/记忆/勾选/commit+push+CI 全绿

## 红线
- [x] 后端零改动（git diff 不含 apps/api）
- [x] 无新依赖；不造假数据（未覆盖如实 null 呈现）
