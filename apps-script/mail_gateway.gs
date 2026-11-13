/**
 * 房价雷达——Google Apps Script MailApp 邮件网关（PRD V1.2 §7.1 Apps Script Gateway 安全设计）
 *
 * 部署步骤：
 *   1. 用专用免费 Gmail 账号（非个人主邮箱）打开 script.google.com 新建项目；
 *   2. 粘贴本文件全部内容；
 *   3. 项目设置 → 脚本属性 新增：APPS_SCRIPT_HMAC_SECRET = 与 Worker Secret 相同的值；
 *   4. 部署 → 新部署 → 类型「网页应用」→ 执行身份「以我本人的身份执行」
 *      → 访问权限「任何人」→ 部署并记录 Web App URL；
 *   5. Worker 侧配置：wrangler secret put APPS_SCRIPT_WEB_APP_URL / APPS_SCRIPT_HMAC_SECRET。
 *
 * 安全约束：
 *   - 仅接受固定模板（otp / price_alert / daily_digest），不是开放邮件代理；
 *   - 所有请求必须通过 HMAC 验签（方法+完整 body+时间戳+request_id），时间偏差 ≤60 秒；
 *   - request_id 经 CacheService 防重放，LockService 防并发重复发送；
 *   - 每次发送前检查 MailApp.getRemainingDailyQuota()，配额耗尽直接拒绝；
 *   - 本脚本只执行发送：不生成验证码、不判断用户是否存在、不验证 OTP；
 *   - 日志不记录验证码与完整正文；密钥泄漏时轮换属性并重新部署。
 */

var ALLOWED_TEMPLATES = ["otp", "price_alert", "daily_digest"];
var MAX_SKEW_SECONDS = 60;
var REPLAY_CACHE_SECONDS = 300;

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var props = PropertiesService.getScriptProperties();
    var secret = props.getProperty("APPS_SCRIPT_HMAC_SECRET");
    if (!secret) {
      return json_({ ok: false, error: "secret_not_configured" });
    }

    var raw = e && e.postData && e.postData.contents;
    if (!raw) return json_({ ok: false, error: "empty_body" });

    var headers = (e && e.postData && e.postData.headers) || {};
    var signature = header_(headers, "X-PR-Signature");
    var timestamp = header_(headers, "X-PR-Timestamp");
    var requestId = header_(headers, "X-PR-Request-Id");
    if (!signature || !timestamp || !requestId) {
      return json_({ ok: false, error: "missing_signature_headers" });
    }

    // 时间戳偏差校验（±60 秒）
    var skew = Math.abs(Math.floor(Date.now() / 1000) - parseInt(timestamp, 10));
    if (!isFinite(skew) || skew > MAX_SKEW_SECONDS) {
      return json_({ ok: false, error: "timestamp_out_of_window" });
    }

    // request_id 防重放：已见过的直接拒绝
    var cache = CacheService.getScriptCache();
    if (cache.get("pr_req_" + requestId)) {
      return json_({ ok: false, error: "replayed" });
    }

    // HMAC 验签：canonical = METHOD\nbody\ntimestamp\nrequest_id
    var canonical = ["POST", raw, timestamp, requestId].join("\n");
    var expected = hex_(Utilities.computeHmacSha256Signature(canonical, secret));
    if (!constantTimeEqual_(expected, String(signature).toLowerCase())) {
      return json_({ ok: false, error: "bad_signature" });
    }
    cache.put("pr_req_" + requestId, "1", REPLAY_CACHE_SECONDS);

    // 请求体校验：仅固定模板，禁止任意收件人/任意正文
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      return json_({ ok: false, error: "invalid_json" });
    }
    if (ALLOWED_TEMPLATES.indexOf(payload.template) === -1) {
      return json_({ ok: false, error: "template_not_allowed" });
    }
    if (!payload.to || String(payload.to).indexOf("@") === -1) {
      return json_({ ok: false, error: "invalid_recipient" });
    }

    // 免费额度：发送前核验剩余配额（PRD §7.1「每次发送前调用 getRemainingDailyQuota」）
    if (MailApp.getRemainingDailyQuota() <= 0) {
      return json_({ ok: false, error: "quota_exhausted" });
    }

    if (payload.template === "otp") {
      if (!/^[0-9]{6}$/.test(String(payload.code))) {
        return json_({ ok: false, error: "invalid_otp_code" });
      }
      var ttl = parseInt(payload.ttl_minutes, 10) || 10;
      MailApp.sendEmail(
        String(payload.to),
        "【房价雷达】登录验证码",
        "您的登录验证码：" +
          String(payload.code) +
          "\n" +
          ttl +
          " 分钟内有效，请勿泄露给他人。\n如非本人操作，请忽略本邮件。"
      );
    } else if (payload.template === "price_alert") {
      // TASK-05B R4.2：事件邮件 HTML 模板（字段映射 R1.2 九要素；正文 HTML 转义）
      MailApp.sendEmail(
        String(payload.to),
        subject_(payload, "房价雷达提醒"),
        "",
        { htmlBody: buildPriceAlertHtml_(payload) }
      );
    } else if (payload.template === "daily_digest") {
      // TASK-05B R4.2：每日摘要 HTML 模板（概述 + 事件明细 + 链接，字段映射 R2.3）
      MailApp.sendEmail(
        String(payload.to),
        subject_(payload, "房价雷达每日摘要"),
        "",
        { htmlBody: buildDigestHtml_(payload) }
      );
    } else {
      // ALLOWED_TEMPLATES 之外的兜底（结构保持：未知模板一律拒绝）
      return json_({ ok: false, error: "template_not_implemented" });
    }

    return json_({ ok: true });
  } catch (err) {
    // 错误分类回传，不输出密钥与邮件正文
    return json_({ ok: false, error: "send_failed" });
  } finally {
    lock.releaseLock();
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// ---- TASK-05B 模板渲染（HTML 全量转义；只渲染 Worker 传入的展示字段） ----

function htmlEscape_(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function subject_(payload, fallback) {
  var s = payload.subject ? String(payload.subject).trim() : "";
  if (!s) return fallback;
  return s.length > 200 ? s.slice(0, 200) : s;
}

function cell_(value, isLabel) {
  var base =
    "padding:8px 12px;border:1px solid #e5e7eb;font-size:14px;vertical-align:top";
  var style = isLabel
    ? base + ";width:112px;color:#6b7280;background:#f9fafb"
    : base + ";color:#111827";
  return '<td style="' + style + '">' + htmlEscape_(value) + "</td>";
}

function wrapHtml_(inner) {
  return (
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111827;line-height:1.6">' +
    inner +
    '<p style="color:#6b7280;font-size:12px;margin-top:20px">本邮件由房价雷达按您的通知设置自动发送；可在站内「通知设置」中关闭邮件提醒或调整每日摘要。</p>' +
    "</div>"
  );
}

/** price_alert：对象/指标/目标/当前/价差/数据日期/来源/样本量 + 页面链接（R1.2 九要素） */
function buildPriceAlertHtml_(p) {
  var rows = [
    ["对象", p.object_name],
    ["指标", p.metric_name],
    ["目标（阈值）", p.target],
    ["当前值", p.current],
    ["价差", p.gap],
    ["数据日期", p.date],
    ["来源", p.source],
    ["样本量", p.samples],
  ];
  var body = "";
  for (var i = 0; i < rows.length; i++) {
    body +=
      "<tr>" +
      cell_(rows[i][0], true) +
      cell_(rows[i][1], false) +
      "</tr>";
  }
  return wrapHtml_(
    '<h2 style="font-size:18px;margin:0 0 14px">' +
      htmlEscape_(subject_(p, "房价雷达提醒")) +
      "</h2>" +
      '<table role="presentation" style="border-collapse:collapse;width:100%;margin-bottom:16px">' +
      body +
      "</table>" +
      '<p style="margin:0 0 8px"><a href="' +
      htmlEscape_(p.link || "#") +
      '" style="color:#2563eb;font-size:14px">前往事件中心查看</a></p>'
  );
}

/** daily_digest：概述行 + 事件明细（对象/类型/变化/链接）+ 页面链接（R2.3） */
function buildDigestHtml_(p) {
  var lines = p.summary_lines || [];
  var items = "";
  for (var i = 0; i < lines.length; i++) {
    items +=
      '<li style="margin:4px 0;font-size:14px">' +
      htmlEscape_(lines[i]) +
      "</li>";
  }
  var rows = p.event_rows || [];
  var trs =
    '<tr><th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;color:#6b7280;font-size:13px;text-align:left">对象</th>' +
    '<th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;color:#6b7280;font-size:13px;text-align:left">类型</th>' +
    '<th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;color:#6b7280;font-size:13px;text-align:left">变化</th>' +
    '<th style="padding:8px 12px;border:1px solid #e5e7eb;background:#f9fafb;color:#6b7280;font-size:13px;text-align:left">链接</th></tr>';
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j] || {};
    trs +=
      "<tr>" +
      cell_(r.object_name, false) +
      cell_(r.type_label, false) +
      cell_(r.change_summary, false) +
      '<td style="padding:8px 12px;border:1px solid #e5e7eb;font-size:14px;white-space:nowrap"><a href="' +
      htmlEscape_(r.link || p.link || "#") +
      '" style="color:#2563eb">查看</a></td>' +
      "</tr>";
  }
  return wrapHtml_(
    '<h2 style="font-size:18px;margin:0 0 14px">' +
      htmlEscape_(subject_(p, "房价雷达每日摘要")) +
      "</h2>" +
      '<ul style="margin:0 0 16px;padding-left:20px">' +
      items +
      "</ul>" +
      '<table role="presentation" style="border-collapse:collapse;width:100%;margin-bottom:16px">' +
      trs +
      "</table>" +
      '<p style="margin:0 0 8px"><a href="' +
      htmlEscape_(p.link || "#") +
      '" style="color:#2563eb;font-size:14px">前往事件中心查看全部事件</a></p>'
  );
}

function header_(headers, name) {
  var lower = name.toLowerCase();
  for (var key in headers) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function hex_(bytes) {
  var out = "";
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}

function constantTimeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
