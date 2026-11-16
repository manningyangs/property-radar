# TASK-07A 验收 Checklist

## 任务书覆盖 12 项（行 1380，逐项 security.test.ts 实证）
- [ ] IDOR：跨用户 watch/rule/event/subscription 全 404；body 传 user_id 被拒
- [ ] CSRF：cookie HttpOnly/Secure/SameSite=Lax；跨站无凭证放行头；未登录写操作 401
- [ ] XSS：恶意 HTML 原样存为文本；响应恒 application/json；无 HTML 回显
- [ ] SQL Injection：路径/查询/body 注入串 400/404；库结构完好可继续正常使用
- [ ] SSRF：用户输入 URL 不触发服务端 fetch；外部调用仅固定 env 白名单端点
- [ ] OTP 暴力破解：5 次错误锁定（正确码也拒）；冷却与窗口限流 429
- [ ] 邮箱枚举：存在/不存在邮箱响应字节级一致
- [ ] Session fixation：登录必发新 token；伪造 cookie 不沿用；logout 即失效
- [ ] 管理员越权：401/403/403 mfa_required 门禁矩阵覆盖各 admin 端点组
- [ ] Secrets 泄露：全部响应不含任何 env 哨兵密钥值
- [ ] CORS：白名单回显+credentials；非白名单零头；绝不 `*`+credentials
- [ ] 错误日志泄露：500 信封无 stack/SQL/message；访问日志无 cookie/OTP

## Secrets 门禁（R2）
- [ ] scripts/check-secrets.mjs 本地全仓扫描通过并留输出
- [ ] ci.yml secrets-scan job 接入（最小 permissions、SHA 固定 checkout）
- [ ] CI 上该 job 实际 success

## 上线门槛相关（1395）
- [ ] 用户隔离和管理员权限测试通过（本套件实证）
- [ ] 没有明文密钥进入仓库（扫描实证 + .dev.vars 忽略确认）

## 工程质量
- [ ] 发现漏洞本任务内修复 + 回归断言（或记录未发现）
- [ ] 四门禁全绿；全量回归通过
- [ ] 中文 commit + push + CI success
- [ ] 验收报告 docs/ + 证据 docs/evidence/ + 三件套勾选收尾
