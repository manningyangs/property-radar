# TASK-08C 验收清单（checklist）

## 需求逐条

- [x] R1 首页游客：system/status + 最近更新小区真实渲染；零演示数字（grep dist 无 demo 文案/数字）
- [x] R2 `/regions`：真实区县列表 + 搜索可用（本地+生产各实测一次）
- [x] R3 `/region`：summary 指标四要素齐全（口径/来源/数据日期/样本量）
- [x] R4 `/communities`：真实 q 搜索有结果（"万科"命中）、空结果诚实空态
- [x] R5 `/community`：详情 + 历史价格趋势渲染；SourceAttribution 展示
- [x] R6 `/cities` 页存在且可用：目录搜索、active/limited/requestable 徽章、coverage 展开；游客选城刷新全站范围（localStorage 持久化，刷新后保持）
- [x] R6b `POST /me/city-coverage-requests`：成功/pending 重复 409/非法城市 400 三例测试绿；生产表可查（登录链路未通则本地证据即可）
- [x] R7 `/methodology`：来源 + 状态真实渲染
- [x] R8 游客 7 路由 Network 面板零 `/me/*` 请求（零 401）
- [x] R9 生产 Pages 实测：青岛真实数据游客可见（截图），构建无 PUBLIC_DEMO_DATA

## 质量与纪律

- [x] 七态状态机覆盖：Loading/Empty/Error(重试)/Stale/Low sample 在对应页面可复现（断网/空库演示至少抽 2 页）
- [x] 视口 360/390/430/1440 无横向溢出（抽首页+小区详情+cities 三页）
- [x] 四门禁 exit 0（typecheck/lint/test/build）
- [x] 证据 `docs/evidence/08c-01..06` 落盘（含生产截图）
- [x] 中文 commit + push + CI success（含 deploy-web 跳过或成功均可）
- [x] 验收报告 + OPERATIONS 更新 + 记忆 + 三件套勾选收尾提交

## 红线复核

- [x] 无密钥进前端（dist grep 无 secret 特征串）
- [x] 未新增付费依赖；未动登录/邮件链路
- [x] 后端仅新增 R6b 一个端点，公共只读 API 零改动
