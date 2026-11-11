# 房价雷达（Property Radar）

> **个人购房决策与价格监控平台。** 用户自主选择城市，设置目标价，系统按合法可用数据源监控价格变化并提醒。

## ⚠️ 仓库强制约束

1. **本仓库为 GitHub Private 私有仓库，不得改为 Public。** 源代码、工作流和内部文档默认不公开。
2. **禁止提交**：任何用户数据、真实价格授权数据、原始房源文件、个人信息、密钥/Token/验证码。
3. 密钥只存 GitHub Actions Repository-level secrets / Cloudflare Worker secrets / 本地 `.env`（已 ignore）。
4. **合规红线**：未取得书面授权前，不得对贝壳/链家/安居客/房天下等平台实现批量爬虫、接口逆向、验证码绕过或任何自动化抓取；数据源必须在 `config/sources/data-sources.json` 登记且状态为 `approved_open` / `approved_licensed` 才允许自动采集。
5. **免费额度红线**：Cloudflare、GitHub、邮件服务均须在免费计划内运行；禁止自动升级或超额付费。

## 工程结构

```text
apps/web/                 # Astro + TypeScript 前端（移动端优先，PWA）
apps/api/                 # Cloudflare Worker API（Hono）
collectors/               # Python 数据采集/规范化（仅授权来源）
config/cities/            # 城市目录种子与覆盖配置（不含密钥、不含全国房价数据）
config/sources/           # 数据源登记册（PRD §5.2 状态机）
db/migrations/public/     # Public D1 迁移
db/migrations/private/    # Private D1 迁移
packages/shared/          # 共享枚举/类型/校验
packages/migrations/      # D1 迁移加载器与本地迁移验收测试
docs/                     # PRD、审计与核验报告
.github/workflows/        # CI（最小 permissions，Action 固定 commit SHA）
```

## 开发命令

```powershell
# Windows PowerShell：便携版 Node 22 工具链
$env:PATH = "e:\desktop\wechat_sync\.tools\node-v22.20.0-win-x64;$env:PATH"

pnpm install
pnpm typecheck    # tsc --noEmit / astro check
pnpm lint         # eslint + prettier --check
pnpm test         # vitest
pnpm build        # 各包构建校验（api 含 wrangler dry-run）

# 本地开发
pnpm --filter @property-radar/web dev    # Astro（默认 4321）
pnpm --filter @property-radar/api dev    # wrangler dev（8789）
```

## 门禁（每阶段必须全绿）

`pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm build`

## 文档

- 阶段报告：[docs/TASK-00A-审计报告.md](docs/TASK-00A-审计报告.md)、[docs/TASK-00B-城市数据源可行性报告.md](docs/TASK-00B-城市数据源可行性报告.md)
- 产品需求与任务书：PRD V1.2（内部文档，不入库则见负责人处）
