# Checklist

## API 与数据

- [x] GET `/me/watch-items` 支持 `status|object_type|group_name|sort|order`，非法参数返回 400 `errors.validation`
- [x] 响应 item 携带 `group_name` 与 `auto_monitoring`，每类型 1 条批量 SQL（无 N+1）
- [x] 暂停（paused）/恢复（active）状态往返正确，status 筛选生效
- [x] 分组：创建带组、PATCH 改组、`group_name=null` 移出、筛选生效、改名后旧组不命中
- [x] 去重：同对象重复 POST → 409
- [x] 目录校验：不存在的 region/community → 404；未覆盖但存在的对象可收藏且 `auto_monitoring=false`；有价格快照 → true（种子 TEST- 数据验证）
- [x] listing 类型不校验目录、`auto_monitoring` 恒 false
- [x] 删除 watch item → 关联 `watch_rules`、`watch_item_groups` 行全部消失（按约定停用）
- [x] 数据隔离：跨用户 GET/PATCH/DELETE → 404，group 筛选不跨用户泄漏
- [x] 多对象：多类型对象混合创建、排序、筛选、删除交叉操作正确
- [x] 迁移 0003：`PRIVATE_TABLES` 含 `watch_item_groups`（15 张），up 重复执行幂等，down 干净
- [x] 既有测试全部保持通过

## 前端

- [x] `src/lib/api.ts` 统一错误信封解析，401 → `/login?next=`，`credentials:"include"`
- [x] login：演示分支行为与 01B 一致（123456、DEMO 标签）
- [x] login：真实分支 Turnstile 未配置时表单禁用并提示，绝不放行；成功登录按 next 跳转；429/401/503 文案友好（503"登录服务未配置"已浏览器实测；401/429 按同一信封映射代码走查）
- [x] watch 列表真实数据渲染；`auto_monitoring=false` 显示"未开启自动价格监控"徽标（true 隐藏徽标亦实测）；规则字段占位不造数
- [x] 暂停/恢复/删除/排序/分组筛选操作全部走真实 API（浏览器实测暂停/恢复/分组筛选/删除确认；排序由 API 测试覆盖并走查接线）
- [x] watch/add：房源类型禁用并注明"需数据来源支持"；409 提示已在列表；成功后按响应展示监控状态提示
- [x] 未登录访问 /watch → 跳转登录（/login?next=%2Fwatch）

## 合规与流程

- [x] 产物中无真实 token/验证码/邮箱；`.gitignore` 已含 `.dev.vars`；`.env.example` 只列变量名
- [x] 四门禁全绿：typecheck / lint / test / build
- [x] 中文 commit `TASK-03A: …` → push → CI 绿
- [x] §12.0 收尾报告输出（改动摘要/文件/测试/风险/回滚），记忆 topics.md 已更新
