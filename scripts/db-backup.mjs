// TASK-07C：D1 生产库手动备份（任务书 1388「测试数据库备份和恢复」）
// 用法：node scripts/db-backup.mjs
//   对 radar_public / radar_private 执行 `wrangler d1 export --remote`，
//   产物落 backups/<UTC时间戳>/（.gitignore，PII 不出本机、不进 git/CI）。
//   完成后生成 manifest.json：SHA256 + 字节数 + wrangler 版本，供恢复演练核对。
// 退出码非 0 = 任一库导出失败；日志只输出摘要，不含任何行数据。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(ROOT, "apps", "api");
const DBS = ["radar_public", "radar_private"];

/** 解析 apps/api 依赖里的 wrangler CLI 入口（node 直调 bin，绕开 Windows .cmd shell 问题） */
function resolveWranglerBin() {
  const req = createRequire(join(API_DIR, "package.json"));
  const main = req.resolve("wrangler").replaceAll("\\", "/");
  const marker = "/node_modules/wrangler/";
  const idx = main.lastIndexOf(marker);
  if (idx === -1) throw new Error(`无法从解析路径定位 wrangler 包目录: ${main}`);
  const pkgDir = main.slice(0, idx + marker.length - 1).replaceAll("/", sep);
  const bin = join(pkgDir, "bin", "wrangler.js");
  return existsSync(bin) ? bin : main;
}

const WRANGLER = resolveWranglerBin();

function wrangler(args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sha256(file) {
  return new Promise((done, fail) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("end", () => done(h.digest("hex"))).on("error", fail);
  });
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(ROOT, "backups", stamp);
  mkdirSync(outDir, { recursive: true });
  const version = wrangler(["--version"]).trim().split(/\r?\n/).at(-1);
  console.log(`wrangler ${version} → ${join("backups", stamp)}`);
  const files = [];
  for (const db of DBS) {
    const out = join(outDir, `${db}.sql`);
    console.log(`export ${db} --remote ...`);
    wrangler(["d1", "export", db, "--remote", "--output", out]);
    if (!existsSync(out)) throw new Error(`${db} 导出文件不存在`);
    files.push({
      db,
      file: `${db}.sql`,
      bytes: readFileSync(out).byteLength,
      sha256: await sha256(out),
    });
    console.log(`  ok: ${files.at(-1).bytes} bytes`);
  }
  const manifest = { exported_at: new Date().toISOString(), wrangler_version: version, files };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`DONE manifest=${join("backups", stamp, "manifest.json")}`);
}

main().catch((e) => {
  console.error(`BACKUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
