# 08B-T4：S6 恶意 HTML/XSS 前端渲染侧审计（矩阵 14.3 S6 缺口收口）

> 背景：07A security.test.ts 已证 API 侧"存储回读原样文本恒 JSON"；本审计收口渲染侧——
> 08C 前端全部 `innerHTML` 注入点是否对用户可控字段（小区名/区域名/事件文案/来源名/URL）转义。
> 审计方法：grep 全量 `innerHTML|insertAdjacentHTML|outerHTML|document.write|href="${|src="${` 注入点，逐一核对数据来源与转义方式。

## 审计范围与结论（apps/web/src，25 处 innerHTML + 2 处 href 拼接）

| 页面 | 注入点 | 数据来源 | 结论 |
| --- | --- | --- | --- |
| index.astro | L414 小区简卡 | API 小区名/区域名 | ✅ 静态骨架 + `textContent` 填值，防注入注释明示 |
| region.astro | L491 指标卡 | API 快照字段 | ✅ 同上模式 |
| community.astro | L478-482 / L594 | 快照字段 | ✅ 保存/还原静态 SSR 骨架；hero 为骨架+textContent |
| events.astro | L199 未读徽章 | 数值计数 | ✅ 数字插值；事件文本（display_name/explanation）全走 textContent（L454-460） |
| login.astro | L259/373 | 用户输入邮箱 | ✅ 骨架空 `<strong>` + textContent 填邮箱 |
| rules.astro | L530 渠道徽章 | 页面固定 checkbox value | ✅ 枚举常量非用户输入 |
| admin.astro | L514/536 | API 来源状态/城市名 | ✅ 全部 `escHtml()`（含未知枚举 fallback） |
| admin/jobs.astro | L225-287 | API 任务行（source_name/error_code/note…） | ✅ 全字段 `esc()`；statusText/kindText 为固定三元字符串；statusBadge 仅返回类名映射 |
| admin/quality.astro | L196-264 | API 异常行（source_name/locator/note…） | ✅ 全字段 `esc()`，locator 键值均转义 |
| admin/sources.astro | L374/496-517/566-591/650-653 | API 来源行/审批历史 | 🟡→✅ 主表与历史全字段 `esc()`；**发现两处缺口，本次最小修复**（见下） |

## 发现与修复（admin/sources.astro）

1. **徽章未知枚举 fallback 未转义**：`statusBadge/healthBadge` 的 `STATUS_META[status] ?? { label: status }` 回退分支把原始字符串直接插进 innerHTML。修复：fallback 同样 `esc(m.label)`。
2. **URL 存储型点击 XSS**：后端 `official_url/license_note_url` schema 仅限长度无 scheme 校验（security.test.ts L549-574 已证内网 URL 可登记——展示零 fetch，但前端直接拼 `<a href>`）。管理员登记 `javascript:`/`data:` scheme 后，后台详情抽屉点击即执行。修复：新增 `urlCell()` 渲染白名单——仅 `http(s)://` 成超链接，其它 scheme 按转义纯文本呈现；两处拼接点替换。

修复后渲染链复核：详情抽屉 `.map(([k,v]) => <dt>${k}</dt><dd>${v}</dd>)` 的 k 为固定字面量、v 全部经 esc/urlCell——无残留拼接点。全项目 `href="${`/`src="${` 动态拼接仅剩已修复的 2 处。

## 残余风险登记（非本项阻断）

- 后端未对 URL 做 scheme 白名单校验（写入侧）。渲染侧白名单已阻断执行路径；写入侧校验登记为 T7 候选（低优先，攻击面=管理员自误）。
- Astro 模板（非 `<script>`）属性插值由编译器自动转义，不在风险面。

## 结论

S6 渲染侧矩阵项：**PASS（修复后）**。公共页统一"骨架+textContent"，后台页统一"模板+esc"，两处 sources.astro 缺口已最小修复并入 T8 门禁回归。
