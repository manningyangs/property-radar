// TASK-07C：备份恢复演练（任务书 1388）——只读验证，绝不写生产库/本地 dev 库。
// 用法：node scripts/db-restore-drill.mjs [backups/<stamp>]（缺省取最新一次备份）
// 流程：备份 SQL → 导入 %TEMP% 临时 sqlite → PRAGMA integrity_check →
//   全部核心表行数对生产远端 COUNT(*) → 抽样行（users/price_snapshots/audit_logs 最新 1 行）
//   字段 SHA256 比对（证据只落哈希，不落行数据/PII）→ 报告写 docs/evidence/07c-01-restore-drill.txt。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const API_DIR = join(ROOT, "apps", "api");
const EVIDENCE = join(ROOT, "docs", "evidence", "07c-01-restore-drill.txt");

const TABLES = {
  radar_public: [
    "cities",
    "communities",
    "data_sources_public",
    "listing_price_events_public",
    "price_observations",
    "price_snapshots",
    "regions",
    "source_city_coverage",
    "source_field_verifications",
    "source_license_state",
  ],
  radar_private: [
    "admin_mfa_secrets",
    "admin_mfa_sessions",
    "admin_roles",
    "alert_events",
    "audit_logs",
    "city_coverage_requests",
    "email_otps",
    "email_send_ledger",
    "ingest_batches",
    "ingest_jobs",
    "ingest_nonces",
    "notification_deliveries",
    "notification_preferences",
    "push_subscriptions",
    "sessions",
    "source_approvals",
    "source_health_reports",
    "user_cities",
    "user_consents",
    "users",
    "watch_item_groups",
    "watch_items",
    "watch_rule_settings",
    "watch_rules",
  ],
};

/** 抽样行：每库取「最新 1 行」的确定性查询（列名以 ORDER BY 表达，不含 PII 输出） */
const SAMPLES = {
  radar_public: [["price_snapshots", "SELECT * FROM price_snapshots ORDER BY stat_date DESC, object_id LIMIT 1"]],
  radar_private: [
    ["users", "SELECT * FROM users ORDER BY created_at DESC, user_id LIMIT 1"],
    ["audit_logs", "SELECT * FROM audit_logs ORDER BY created_at DESC, audit_id LIMIT 1"],
  ],
};

function resolveWranglerBin() {
  const req = createRequire(join(API_DIR, "package.json"));
  const main = req.resolve("wrangler").replaceAll("\\", "/");
  const marker = "/node_modules/wrangler/";
  const idx = main.lastIndexOf(marker);
  if (idx === -1) throw new Error(`无法定位 wrangler 包目录: ${main}`);
  const pkgDir = main.slice(0, idx + marker.length - 1).replaceAll("/", sep);
  const bin = join(pkgDir, "bin", "wrangler.js");
  return existsSync(bin) ? bin : main;
}
const WRANGLER = resolveWranglerBin();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CF API 偶发 fetch failed：最多 4 次尝试、指数退避 */
async function wranglerJson(args) {
  let out;
  for (let attempt = 1; ; attempt++) {
    try {
      out = execFileSync(process.execPath, [WRANGLER, ...args], {
        cwd: API_DIR,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      break;
    } catch (e) {
      const stdout = e instanceof Error && "stdout" in e ? String(e.stdout ?? "") : "";
      if (attempt >= 4 || !/fetch failed|connectivity/i.test(stdout + String(e))) {
        throw new Error(`wrangler 失败: ${stdout.slice(0, 400) || String(e)}`);
      }
      await sleep(2000 * attempt);
    }
  }
  const parsed = JSON.parse(out.slice(out.indexOf("[") >= 0 ? out.indexOf("[") : out.indexOf("{")));
  // 兼容 [{results:[...]}] 与 {result:{results:[...]}} 两种输出形态
  const stack = [parsed];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const n of node) stack.push(n);
      if (node.length && typeof node[0] === "object" && node[0] !== null && "results" in node[0]) return node;
    } else if (node && typeof node === "object") {
      if ("results" in node) return [node];
      for (const v of Object.values(node)) stack.push(v);
    }
  }
  throw new Error(`无法解析 wrangler JSON 输出`);
}

/** D1 对 compound SELECT 项数限制很严、--file 只回显汇总——每表一条独立 --command 查询 */
async function remoteCount(db, tables) {
  const map = {};
  for (const t of tables) {
    const res = await wranglerJson([
      "d1",
      "execute",
      db,
      "--remote",
      "--command",
      `SELECT COUNT(*) AS c FROM ${t}`,
      "--json",
    ]);
    const row = res.flatMap((g) => g.results ?? [])[0];
    if (!row) throw new Error(`${db}.${t} 远端 COUNT 无结果`);
    map[t] = Number(row.c);
  }
  return map;
}

async function remoteSample(db, sql) {
  const res = await wranglerJson(["d1", "execute", db, "--remote", "--command", sql, "--json"]);
  const rows = res.flatMap((g) => g.results ?? []);
  return rows[0] ?? null;
}

function rowHash(row) {
  if (row === null) return "NULL";
  const keys = Object.keys(row).sort();
  return createHash("sha256").update(JSON.stringify(keys.map((k) => row[k]))).digest("hex");
}

function findBackup() {
  const arg = process.argv[2];
  if (arg) return resolve(ROOT, arg);
  const base = join(ROOT, "backups");
  const dirs = readdirSync(base).filter((d) => existsSync(join(base, d, "manifest.json"))).sort();
  if (dirs.length === 0) throw new Error("backups/ 下没有含 manifest.json 的备份，先运行 db-backup.mjs");
  return join(base, dirs.at(-1));
}

async function main() {
  const backupDir = findBackup();
  const manifest = JSON.parse(readFileSync(join(backupDir, "manifest.json"), "utf8"));
  const lines = [
    `TASK-07C 恢复演练（只读，TEMP 导入）`,
    `backup=${backupDir} exported_at=${manifest.exported_at} wrangler=${manifest.wrangler_version}`,
    `drill_at=${new Date().toISOString()}`,
    "",
  ];
  let pass = true;
  for (const entry of manifest.files) {
    const db = entry.db;
    const sqlFile = join(backupDir, entry.file);
    const sqlText = readFileSync(sqlFile, "utf8");
    const local = new DatabaseSync(join(process.env.TEMP ?? "/tmp", `pr07c-restore-${db}.sqlite`));
    try {
      local.exec("PRAGMA foreign_keys = OFF;");
      local.exec(sqlText);
      const integrity = local.prepare("PRAGMA integrity_check").get().integrity_check;
      const intOk = integrity === "ok";
      lines.push(`[${db}] integrity_check=${integrity} ${intOk ? "OK" : "FAIL"}`);
      if (!intOk) pass = false;
      const remote = await remoteCount(db, TABLES[db]);
      for (const t of TABLES[db]) {
        const c = Number(local.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);
        const ok = c === remote[t];
        if (!ok) pass = false;
        lines.push(`[${db}] ${t}: backup=${c} remote=${remote[t]} ${ok ? "OK" : "MISMATCH"}`);
      }
      for (const [t, sql] of SAMPLES[db]) {
        const localRow = local.prepare(sql).get() ?? null;
        const remoteRow = await remoteSample(db, sql);
        const h1 = rowHash(localRow);
        const h2 = rowHash(remoteRow);
        const ok = h1 === h2; // 双侧同空（NULL）也算一致
        if (!ok) pass = false;
        const tag = h1 === "NULL" ? "MATCH(empty)" : ok ? "MATCH" : "FAIL";
        lines.push(`[${db}] sample ${t} sha256=${h1.slice(0, 12)} vs ${h2.slice(0, 12)} ${tag}`);
      }
    } finally {
      local.close();
      rmSync(join(process.env.TEMP ?? "/tmp", `pr07c-restore-${db}.sqlite`), { force: true });
    }
    lines.push("");
  }
  lines.push(pass ? "RESULT: PASS" : "RESULT: FAIL");
  mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
  writeFileSync(EVIDENCE, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(`RESTORE DRILL FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
