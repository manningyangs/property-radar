# Checklist

## 数据与状态机

- [x] 迁移 Public 0002 `source_license_state`、Private 0005 `source_approvals`/`ingest_batches`/`ingest_nonces`，up 重复执行幂等、down 干净
- [x] PUBLIC_TABLES +1、PRIVATE_TABLES +3；status 七态与 coverage authorization_status CHECK 生效；nonce 主键冲突可检测
- [x] 审批证据（evidence_ref/字段/用途/频率/保存期限/覆盖范围/审批人）只入 Private `source_approvals`，append-only（无 UPDATE/DELETE 端点）
- [x] 新登记来源状态 = discovered；PATCH 不接受 status（400）

## 审批与停用（管理端）

- [x] `requireAdmin`：未登录 401、普通用户 403 `admin_required`、有 admin_roles 有效行放行；非 admin 路由不受影响
- [x] approve 必填五件套+coverage 任一缺失 → 400，来源状态与审批记录不变
- [x] approve 成功四写：source_approvals + source_license_state + upsert source_city_coverage（city_code 不存在 → 404）+ audit_logs(`source.approve`)
- [x] 状态转换门禁：blocked → approve 409；approved_* 重复 approve 409（须先 suspend）；非法转换不写库
- [x] suspend 必填 reason → status/coverage 同步 suspended + audit_logs(`source.suspend`)

## 门禁与批次（验收）

- [x] **验收一：`pending_review` 来源携带合法签名批次 → 403 `source_not_approved`，不写 ingest_batches**
- [x] **验收二：approved 来源批次 202 后 suspend → 下一批 403 `source_not_approved`，无新批次行**
- [x] 超范围批次（缺 coverage 行 / object_level 不符 / authorization_status 未批准 / 城市非 active|limited）→ 403 `city_coverage_denied`；未知 source → 404
- [x] 惰性过期自动 suspend：valid_until 已过 → 门禁判定前库中状态已改 suspended、coverage 同步、audit_logs(`source.auto_suspend`, reason=license_expired)
- [x] 签名链：缺 secret → 403 `ingest_disabled`；时间戳偏差>300s → 403 `stale_timestamp`；重放 nonce → 403 `replay_detected`；篡改 body → 403 `signature_invalid`；secret 不出现在日志/响应
- [x] 门禁通过 → 202 `{batch_id,status:'accepted'}` 且 ingest_batches 行字段正确；04A 不解析观测明细

## 展示与合规

- [x] `GET /public/methodology/sources` 附 `license_status`/`license_valid_until`（缺行 discovered），不含 evidence_ref/审批人等私有字段
- [x] `INGEST_HMAC_SECRET` 只以 Secret/本地占位进 wrangler 配置，`.env.example` 仅名称；产物无真实密钥/token/邮箱
- [x] 审计只写不读（GET /admin/audit 留 06C）；管理 UI 不动（06C）

## 门禁与流程

- [x] `pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm -r build` 四门禁全绿
- [x] 浏览器回归：真实模式首页/登录/watch/rules 正常、401→`/login?next=…` 跳转；演示模式（PUBLIC_DEMO_DATA=1）行为与 01B 一致
- [x] 中文 commit `TASK-04A: …` → push → CI 绿
- [x] §12.0 收尾报告输出（改动摘要/文件/测试/风险/回滚），checklist 勾选入库，记忆 topics.md / project_memory.md 更新

## 实施偏差说明

- SubTask 5.2 的「wrangler.jsonc 本地占位 var」未照字面实现：`wrangler secret put --local` 不支持 `--local` 标志，本地 secret 改走已 gitignore 的 `apps/api/.dev.vars`；`wrangler.jsonc` 仅在注释的 secrets 清单中列出 `INGEST_HMAC_SECRET`。`.env.example` 已含该名称（PRD 预留），无需改动。
- validation.ts 白名单除 `items` 外同时新增 `minItems`（approve coverage「至少 1 项」需要），否则 strict 白名单会抛错。
- 本地验收脚本（临时文件，不入库）曾因对 raw body 二次 `JSON.stringify` 导致签名不匹配，属脚本缺陷，产品代码签名链与单测一致。
