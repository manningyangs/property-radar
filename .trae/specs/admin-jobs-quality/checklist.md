# TASK-06D 验收 Checklist

## 任务行验收条款（1374）
- [ ] 每一异常可定位 source、batch、connector version 和具体错误码（单测非空断言 + 浏览器抽屉实证）
- [ ] 重跑有幂等保护（同 batch_id 重提 202 duplicate 不重写；同观测重提行数不变；finish 幂等不改写——单测实证 + 页面说明）
- [ ] 1440px/1024px 后台布局清晰；表格小屏横向滚动或卡片视图；不遮挡关键操作（双档截图存证）

## UI 要求（1372）
- [ ] 左侧深海军蓝导航（#14253D）+ 白色主内容区（AdminSidebar/tokens 复用）
- [ ] 顶部城市选择/城市覆盖状态/系统健康状态
- [ ] 首屏指标卡：任务成功率、数据更新时间、已覆盖小区数、来源异常数（overview.ops）
- [ ] 数据表搜索/筛选/排序/分页（jobs 与 quality 两页）
- [ ] 审批和停用确认弹窗（06C 已有，本页面无新增写操作——只读口径记录）
- [ ] 敏感用户信息默认脱敏（本任务页面不展示用户明细；overview 零 PII 语义延续）
- [ ] 状态颜色与用户端一致 + 颜色不作唯一编码（文字+图标并存）

## 工程质量
- [ ] 迁移幂等可重复；旧行 NULL 兜底；canonicalObservation 不含 batch_id（observation_id 稳定）
- [ ] internal 新字段全部可选，04B/04D/04E 载荷向后兼容（既有测试零修改通过）
- [ ] 四门禁全绿；全量回归通过
- [ ] admin-ops 三端点均由 requireAdminAccess 统一门禁（401/403 矩阵覆盖）
- [ ] 新页面含 [hidden]{display:none!important} 兜底
- [ ] commit/push/CI success；验收报告与截图存 docs/
