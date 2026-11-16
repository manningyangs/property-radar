# TASK-07B 验收 Checklist

## A. 检查项（任务书 1384 逐条）

- [x] A1 逐数据源复核许可范围：10 源 status×license×连接器一致性表进报告；无未授权平台爬虫（贝壳/链家/安居客无 connector，allowlist 门禁在）
- [x] A2 逐页面核对数据来源展示：8 个含数据页面全有来源标注（组件或字段）；不适用页面列清单说明；截图证据 07b-05（demo 模式重截 community/region/index/events 4 页 + 生产空态即合规说明）
- [x] A3 隐私政策：/privacy 全文含 PRD 703 七要素（处理者/目的/方式/类别/保存期限/权利/联系），占位项显式标注
- [x] A4 用户协议：/terms 全文（服务性质/账号/口径免责/可接受使用/配额/变更终止）
- [x] A5 数据导出：/me/export 真实可用，JSON 含全部个人数据类别（13 键），仅本人数据，浏览器实测下载（07b-02）
- [x] A6 数据删除：/me/delete-account 冷静期语义实测（会话即时失效+撤销 deletion_cancelled+7 天硬删 cron+D1 核验）（07b-03）
- [x] A7 保留期限：实现清单成文进隐私政策（OTP/会话/推送/冷静期/审计）+报告第 6 节保留期限清单
- [x] A8 第三方处理者说明：Cloudflare、Google Apps Script 逐一列明用途与数据面（privacy 第六节+报告第 7 节）

## B. 工程门禁

- [x] B1 typecheck / lint / test / build 四门禁全绿（build 18 页）
- [x] B2 全量测试通过：api 328（含 data-compliance 10）/ shared 18 / migrations 27（含 0016 断言）
- [x] B3 无明文密钥进仓库（secrets-scan CI job 通过）
- [x] B4 commit 中文规范、push、CI success（01b5bcc / run 43819553896）
- [x] B5 上线门槛核对：账号删除、隐私政策两项由本任务补齐（用户隔离/管理员权限 07A 已过）

## C. 移交 07C

- [x] C1 占位联系邮箱替换为真实邮箱（开放注册前硬性）——已列报告第 10 节待办 1
- [x] C2 跨境处理合规由专业人员核验（PRD 705）——已列报告第 10 节待办 2
- [x] C3 隐私政策 Cloudflare 出站限制选项评估（07A 报告遗留项）——已列报告第 10 节待办 3
