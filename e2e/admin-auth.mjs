// TASK-06A e2e：wrangler dev 真机验收（PRD 任务行 1346–1352 / spec DoD）
// 流程：本地 D1 种子（两用户+会话）→ 起 wrangler dev → 401/403 门禁矩阵
//       → bootstrap 建管理员（幂等）→ MFA setup/verify → 业务端点 200
//       → GET /admin/audit 可查 → 收尾杀进程。
// 用法：node e2e/admin-auth.mjs   （需已配 apps/api/.dev.vars 的 ADMIN_BOOTSTRAP_CODE）
import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const API_DIR = path.join(ROOT, "..", "apps", "api");
const PORT = process.env.E2E_PORT ?? "9616";
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_CODE = "local-bootstrap-06a-e2e-code"; // 与 apps/api/.dev.vars 一致（本地专用）

const ADMIN = "usr-e2e-admin-06a";
const PLAIN = "usr-e2e-plain-06a";
const TOK_ADMIN = "tok-e2e-admin-06a";
const TOK_PLAIN = "tok-e2e-plain-06a";
const EMAIL_ADMIN = "e2e-admin-06a@example.com";
const EMAIL_PLAIN = "e2e-plain-06a@example.com";

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

// ---- TOTP（RFC 6238 最小实现，与 apps/api/src/totp.ts 同口径：SHA1/30s/6位）----
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

// ---- 本地 D1 种子（幂等：先清 06A 相关残留再插；SQL 走临时文件避开 shell 引号问题）----
function seed() {
  const sql = `
DELETE FROM admin_mfa_sessions WHERE user_id IN ('${ADMIN}', '${PLAIN}');
DELETE FROM admin_mfa_secrets  WHERE user_id IN ('${ADMIN}', '${PLAIN}');
DELETE FROM admin_roles        WHERE user_id IN ('${ADMIN}', '${PLAIN}');
DELETE FROM sessions            WHERE session_id IN ('sess_${ADMIN}', 'sess_${PLAIN}');
DELETE FROM users               WHERE user_id   IN ('${ADMIN}', '${PLAIN}');
DELETE FROM audit_logs          WHERE actor_user_id IN ('${ADMIN}', '${PLAIN}');
INSERT INTO users (user_id, email_normalized, email_verified_at) VALUES
  ('${ADMIN}', '${EMAIL_ADMIN}', datetime('now')),
  ('${PLAIN}', '${EMAIL_PLAIN}', datetime('now'));
INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES
  ('sess_${ADMIN}', '${ADMIN}', '${sha256Hex(TOK_ADMIN)}', datetime('now', '+1 day')),
  ('sess_${PLAIN}', '${PLAIN}', '${sha256Hex(TOK_PLAIN)}', datetime('now', '+1 day'));
`;
  const tmp = path.join(os.tmpdir(), "e2e06a-seed.sql");
  fs.writeFileSync(tmp, sql, "utf8");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  execFileSync(
    npx,
    ["wrangler", "d1", "execute", "radar_private", "--local", "--file", tmp, "--yes"],
    { cwd: API_DIR, stdio: "pipe", shell: process.platform === "win32" },
  );
  console.log("seed: 本地 D1 用户/会话就绪（06A 残留已清）");
}

// ---- HTTP 辅助 ----
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

    // 1) 门禁矩阵
    const anon = await call("GET", "/api/v1/admin/sources");
    ok(anon.status === 401 && (await anon.json()).error_code === "unauthorized", "未登录 → 401 unauthorized");

    const plain = await call("GET", "/api/v1/admin/sources", TOK_PLAIN);
    ok(plain.status === 403 && (await plain.json()).error_code === "admin_required", "普通用户 → 403 admin_required");

    const plainAudit = await call("GET", "/api/v1/admin/audit", TOK_PLAIN);
    ok(plainAudit.status === 403, "普通用户访问 /admin/audit → 403");

    // 2) bootstrap：错码 403 → 正确码 201 → 幂等 200
    const wrong = await call("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: "wrong-code-06a",
      email: EMAIL_ADMIN,
    });
    ok(wrong.status === 403 && (await wrong.json()).error_code === "bootstrap_code_invalid", "bootstrap 错码 → 403 bootstrap_code_invalid");

    const first = await call("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: EMAIL_ADMIN,
    });
    const firstBody = await first.json();
    ok(first.status === 201 && firstBody.created === true, "bootstrap 正确码 → 201 created");

    const again = await call("POST", "/api/v1/admin/bootstrap", undefined, {
      bootstrap_code: BOOT_CODE,
      email: EMAIL_ADMIN,
    });
    ok(again.status === 200 && (await again.json()).created === false, "bootstrap 重复 → 200 幂等 created:false");

    // 3) 有角色但未过 MFA → 403 mfa_required
    const noMfa = await call("GET", "/api/v1/admin/sources", TOK_ADMIN);
    ok(noMfa.status === 403 && (await noMfa.json()).error_code === "mfa_required", "admin 未过 MFA → 403 mfa_required");

    // 4) MFA setup → verify → 业务端点 200
    const setup = await call("POST", "/api/v1/admin/mfa/setup", TOK_ADMIN, {});
    const setupBody = await setup.json();
    ok(setup.status === 200 && /^[A-Z2-7]{32}$/u.test(setupBody.secret ?? ""), "mfa/setup → 200 返回 32 字符 secret");

    const verify = await call("POST", "/api/v1/admin/mfa/verify", TOK_ADMIN, {
      code: totp(setupBody.secret),
    });
    ok(verify.status === 200, "mfa/verify 正确码 → 200 session_verified");

    const allowed = await call("GET", "/api/v1/admin/sources", TOK_ADMIN);
    ok(allowed.status === 200, "过 MFA 后 GET /admin/sources → 200");

    const status = await call("GET", "/api/v1/admin/mfa/status", TOK_ADMIN);
    const statusBody = await status.json();
    ok(
      statusBody.enrolled === true &&
        statusBody.confirmed === true &&
        statusBody.session_verified === true,
      "mfa/status 三态全 true",
    );

    // 5) GET /admin/audit 可查（分页 + 筛选）
    const auditAll = await call("GET", "/api/v1/admin/audit?limit=200", TOK_ADMIN);
    const auditBody = await auditAll.json();
    ok(auditAll.status === 200 && auditBody.total >= 3, `GET /admin/audit → 200 total=${auditBody.total} ≥ 3`);

    const auditVerify = await call(
      "GET",
      "/api/v1/admin/audit?action=admin.mfa.verify",
      TOK_ADMIN,
    );
    const verifyBody = await auditVerify.json();
    ok(
      verifyBody.total === 1 && verifyBody.items?.[0]?.actor_user_id === ADMIN,
      "audit 筛选 action=admin.mfa.verify 精确命中 1 条",
    );

    console.log(`\nPASS：${pass} 项断言全部通过`);
  } finally {
    // Windows：server.pid 是 cmd 包装，直接 kill 不会带走 wrangler/workerd 树 → taskkill /T
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
