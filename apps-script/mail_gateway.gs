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
      // 其余模板（price_alert / daily_digest）在对应任务接入，模板未实现时拒绝
    } else {
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
