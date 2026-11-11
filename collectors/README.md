# collectors（Python 采集与规范化）

## 合规红线（PRD §5.4/§5.6）

1. **未获书面授权前，本目录不包含任何针对贝壳/链家/安居客/房天下等平台的爬虫、脚本或逆向代码。**
2. 采集前必须核验：来源在 `config/sources/data-sources.json` 中状态为 `approved_open` / `approved_licensed`，且 §5.3 十项审批记录完整（审批人、证据链接、许可字段、保留期限、复核日期）。
3. 无存储授权时只存规范化字段，不存原始 HTML/图片/个人信息；联系方式字段不入库。
4. 连接器实现（源站变更提示、最小并发与超时、JSONL 原始备份、规范化入库）在取得授权后的对应城市任务中实施。

## 结构约定

```text
collectors/
  README.md                  # 本文件
  requirements.txt           # 依赖清单（按需追加，不预装）
  property_radar_collectors/ # Python 包根
    __init__.py              # 版本与模块出口
```

依赖安装：`pip install -r requirements.txt`（当前为空——授权来源未落地前不引入采集依赖）。
