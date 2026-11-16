// TASK-06B e2e：wrangler dev 真机验收（PRD 任务行 1354–1360 / spec R8）
// 流程：本地 D1 种子（admin/target/plain + target 的 watch/rule）→ 起 wrangler dev
//       → 门禁矩阵 → bootstrap + MFA → overview 聚合（零 PII）→ users 列表脱敏
//       → PATCH 冻结 → target /me/* 401 → monitoring reason 校验 + 明细
//       → audit 两类动作可查 → 解冻恢复登录 → 收尾杀进程。
// 用法：node e2e/admin-users.mjs   （需已配 apps/api/.dev.vars 的 ADMIN_BOOTSTRAP_CODE）
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(ROOT, "..", "apps", "api");
const PORT = process.env.E2E_PORT ?? "9617";
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_CODE = "local-bootstrap-06a-e2e-code"; // 与 apps/api/.dev.vars 一致（本地专用）

const ADMIN = "usr-e2e-admin-06b";
const TARGET = "usr-e2e-target-06b";
const PLAIN = "usr-e2e-plain-06b";
const TOK_ADMIN = "tok-e2e-admin-06b";
const TOK_TARGET = "tok-e2e-target-06b";
const TOK_PLAIN = "tok-e2e-plain-06b";
const EMAIL_ADMIN = "e2e-admin-06b@example.com";
const EMAIL_TARGET = "e2e-target-06b@example.com";
const EMAIL_PLAIN = "e2e-plain-06b@example.com";
const FREEZE_REASON = "e2e 冻结理由测试"; // 8+ 字符
const VIEW_REASON = "e2e 查看监控明细排查投诉"; // 10+ 字符

let pass = 0;
function ok(cond, label) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exitCode = 1;
    throw new Error(label);
  }
  pass++;
  console.log(`  ✓ ${label}`);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// ---- TOTP（与 apps/api/src/totp.ts 同口径：SHA1/30s/6位）----
function base32Decode(s) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of s.replace(/=+$/u, "").toUpperCase()) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totp(secret, timeMs = Date.now()) {
  const step = Math.floor(timeMs / 30000);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[19] & 0xf;
  const bin =
    ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1000000).padStart(6, "0");
}

// ---- 本地 D1 种子（幂等：清 06B 残留再插；SQL 走临时文件避开 shell 引号问题）----
function seed() {
  const sql = `
DELETE FROM watch_rules        WHERE user_id IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
DELETE FROM watch_items        WHERE user_id IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
DELETE FROM audit_logs         WHERE actor_user_id IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
DELETE FROM admin_mfa_sessions WHERE user_id IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
DELETE FROM admin_mfa_secrets  WHERE user_id IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
DELETE FROM admin_roles        WHERE user_id IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
DELETE FROM sessions            WHERE session_id IN ('sess_${ADMIN}', 'sess_${TARGET}', 'sess_${PLAIN}');
DELETE FROM users               WHERE user_id   IN ('${ADMIN}', '${TARGET}', '${PLAIN}');
INSERT INTO users (user_id, email_normalized, email_verified_at) VALUES
  ('${ADMIN}', '${EMAIL_ADMIN}', datetime('now')),
  ('${TARGET}', '${EMAIL_TARGET}', datetime('now')),
  ('${PLAIN}', '${EMAIL_PLAIN}', datetime('now'));
INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES
  ('sess_${ADMIN}', '${ADMIN}', '${sha256Hex(TOK_ADMIN)}', datetime('now', '+1 day')),
  ('sess_${TARGET}', '${TARGET}', '${sha256Hex(TOK_TARGET)}', datetime('now', '+1 day')),
  ('sess_${PLAIN}', '${PLAIN}', '${sha256Hex(TOK_PLAIN)}', datetime('now', '+1 day'));
INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot)
VALUES ('w_e2e_06b', '${TARGET}', 'community', 'cmt_e2e_06b', 'E2E小区（虚构）');
INSERT INTO watch_rules (rule_id, watch_id, user_id, rule_type, metric_code, price_type, target_value, unit)
VALUES ('r_e2e_06b', 'w_e2e_06b', '${TARGET}', 'community_unit_price_lte', 'community_ask_median_unit', 'listing_ask', 30000, '元/㎡');
`;
  const tmp = path.join(os.tmpdir(), "e2e06b-seed.sql");
  fs.writeFileSync(tmp, sql, "utf8");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(
    npx,
    ["wrangler", "d1", "execute", "radar_private", "--local", "--file", tmp, "--yes"],
    { cwd: API_DIR, stdio: "pipe", shell: process.platform === "win32" },
  );
  console.log("seed: 本地 D1 用户/会话/监控就绪（06B 残留已清）");
}

async function call(method, p, token, payload) {
  return fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(payload !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(token ? { Cookie: `pr_session=${token}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

async function waitReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      /* 未就绪 */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev 120s 内未就绪");
}

async function main() {
  seed();

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const server = spawn(npx, ["wrangler", "dev", "--port", PORT], {
    cwd: API_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  server.stdout.on("data", (d) => process.env.E2E_VERBOSE && process.stdout.write(d));
  server.stderr.on("data", (d) => process.env.E2E_VERBOSE && process.stderr.write(d));

  try {
    await waitReady();
    console.log(`wrangler dev 就绪：${BASE}`);

    // 1) 门禁矩阵（4 端点 × 401 / 403）
    for (const p of [
      "/api/v1/admin/overview",
      "/api/v1/admin/users",
      "/api/v1/admin/users/usr_e2e/monitoring?reason=" + encodeURIComponent(VIEW_REASON),
    ]) {
      const anon = await call("GET", p);
      ok(anon.status === 401, `匿名 ${p.split("?")[0]} → 401`);
      const plain = await call("GET", p, TOK_PLAIN);
      ok(plain.status === 403 && (await plain.json()).error_code === "admin_required", `普通用户 → 403 admin_required`);
    }

    // 2) bootstrap + MFA（复用 06A 流程）
    const boot = await call("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: EMAIL_ADMIN,
    });
    const bootBody = await boot.json();
    ok((boot.status === 201 || boot.status === 200) && bootBody.user_id === ADMIN, "bootstrap 创建/幂等管理员");

    const noMfa = await call("GET", "/api/v1/admin/overview", TOK_ADMIN);
    ok(noMfa.status === 403 && (await noMfa.json()).error_code === "mfa_required", "admin 未过 MFA → 403 mfa_required");

    const setup = await call("POST", "/api/v1/admin/mfa/setup", TOK_ADMIN, {});
    const setupBody = await setup.json();
    ok(setup.status === 200, "mfa/setup → 200");
    const verify = await call("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code: totp(setupBody.secret),
    });
    ok(verify.status === 200, "mfa/verify → 200");

    // 3) GET /admin/overview：聚合 + 零 PII
    const ov = await call("GET", "/api/v1/admin/overview", TOK_ADMIN);
    const ovBody = await ov.json();
    ok(ov.status === 200, "GET /admin/overview → 200");
    ok(ovBody.users.total >= 3 && ovBody.users.active >= 3, `users.total=${ovBody.users.total} ≥ 3`);
    ok(ovBody.monitoring.by_object_type.community >= 1, "monitoring.community ≥ 1（target 的监控）");
    ok(ovBody.monitoring.rules_enabled >= 1, "rules_enabled ≥ 1");
    ok(!JSON.stringify(ovBody).includes("@"), "overview 响应零 PII（无 @）");
    ok(!JSON.stringify(ovBody).includes("30000"), "overview 响应无个人目标价");

    // 4) GET /admin/users：脱敏列表
    const ul = await call("GET", "/api/v1/admin/users", TOK_ADMIN);
    const ulBody = await ul.json();
    ok(ul.status === 200 && ulBody.total >= 3, `GET /admin/users → 200 total=${ulBody.total}`);
    const tItem = ulBody.items.find((i) => i.user_id === TARGET);
    ok(tItem && tItem.email_masked === "e2***@example.com", `target 邮箱脱敏为 ${tItem?.email_masked}`);
    ok(tItem.watch_count === 1, "target watch_count=1");
    ok(!JSON.stringify(ulBody).includes(EMAIL_TARGET), "列表无明文邮箱");

    // 5) PATCH 冻结 → target /me/* 401
    const beforeMe = await call("GET", "/api/v1/me/watch-items", TOK_TARGET);
    ok(beforeMe.status === 200, "冻结前 target GET /me/watch-items → 200");

    const patch = await call(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    ok(patch.status === 200 && (await patch.json()).user.status === "frozen", "PATCH 冻结 → 200 status=frozen");

    const selfFreeze = await call(
      "PATCH",
      `/api/v1/admin/users/${ADMIN}/status`,
      TOK_ADMIN,
      { status: "frozen", reason: FREEZE_REASON },
    );
    ok(selfFreeze.status === 409, "自冻结 → 409");

    const afterMe = await call("GET", "/api/v1/me/watch-items", TOK_TARGET);
    ok(afterMe.status === 401 && (await afterMe.json()).error_code === "unauthorized", "冻结后 target /me/* → 401（阻止登录/新建规则）");

    // 6) monitoring：reason 校验 + 明细
    const noReason = await call("GET", `/api/v1/admin/users/${TARGET}/monitoring`, TOK_ADMIN);
    ok(noReason.status === 400 && (await noReason.json()).error_code === "validation_failed", "monitoring 缺 reason → 400");

    const withReason = await call(
      "GET",
      `/api/v1/admin/users/${TARGET}/monitoring?reason=${encodeURIComponent(VIEW_REASON)}`,
      TOK_ADMIN,
    );
    const mr = await withReason.json();
    ok(withReason.status === 200, "monitoring 带 reason → 200");
    ok(mr.counts.watches === 1 && mr.counts.rules === 1, "明细 counts={watches:1, rules:1}");
    ok(mr.watches[0].rules[0].target_value === 30000, "明细含 target_value（受控查看）");
    ok(!JSON.stringify(mr.user).includes(EMAIL_TARGET), "明细 user 邮箱仍脱敏");

    // 7) audit 可查两类动作
    const auditStatus = await call(
      "GET",
      "/api/v1/admin/audit?action=admin.user.status&limit=50",
      TOK_ADMIN,
    );
    const asBody = await auditStatus.json();
    ok(
      asBody.total >= 1 && String(asBody.items[0].reason).includes(FREEZE_REASON),
      `audit admin.user.status 可查（reason 含冻结理由，total=${asBody.total}）`,
    );

    const auditView = await call(
      "GET",
      "/api/v1/admin/audit?action=admin.user.monitoring_view&limit=50",
      TOK_ADMIN,
    );
    const avBody = await auditView.json();
    ok(
      avBody.total === 1 && avBody.items[0].reason === VIEW_REASON,
      "audit monitoring_view 恰 1 条且 reason 原文",
    );

    // 8) 解冻恢复登录
    const unfreeze = await call(
      "PATCH",
      `/api/v1/admin/users/${TARGET}/status`,
      TOK_ADMIN,
      { status: "active", reason: "e2e 解冻恢复" },
    );
    ok(unfreeze.status === 200, "解冻 → 200");
    const restored = await call("GET", "/api/v1/me/watch-items", TOK_TARGET);
    ok(restored.status === 200, "解冻后 target /me/* 恢复 200");

    console.log(`\nPASS：${pass} 项断言全部通过`);
  } finally {
    // Windows：taskkill /T 杀掉 cmd → wrangler → workerd 进程树
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], {
          stdio: "pipe",
        });
      } else {
        server.kill("SIGTERM");
      }
    } catch {
      /* 已退出 */
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
