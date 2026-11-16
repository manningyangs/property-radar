// TASK-07A：Secrets 泄露 CI 门禁（PRD §7.6：Secrets 不进仓库；任务书 1395 上线门槛）
// 纯 Node 无依赖，扫描 git 跟踪的文本文件：
//   HARD 规则（任何文件命中即失败）：私钥块、GitHub/AWS/Slack/OpenAI/Google 等真实密钥形态；
//   SOFT 规则（仅生产代码，测试/文档/本脚本自身豁免）：secret 类键名 + 高熵赋值。
// 用法：node scripts/check-secrets.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HARD_RULES = [
  ["private-key-block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["openai-key", /\bsk-[A-Za-z0-9_-]{35,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["stripe-key", /\b(?:sk|pk|rk)_live_[A-Za-z0-9]{16,}\b/],
];

const SOFT_RULES = [
  [
    "secret-assignment",
    /(?:api[_-]?key|secret|passwd|password|access[_-]?token|auth[_-]?token|private[_-]?key|signing[_-]?secret|hmac[_-]?secret)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/i,
  ],
];

// SOFT 规则豁免路径（测试桩/文档示例/扫描器自身不算真泄露；HARD 规则不豁免）
const SOFT_EXEMPT = [
  /\.test\.[cm]?[jt]sx?$/,
  /(^|\/)tests?\//,
  /(^|\/)test-utils\//,
  /(^|\/)fixtures?\//,
  /^docs\//,
  /^\.trae\/specs\//,
  /^scripts\/check-secrets\.mjs$/,
  /(^|\/)(README|CHANGELOG)\./i,
];

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
  ".ttf", ".eot", ".pdf", ".zip", ".gz", ".br", ".mp3", ".mp4", ".db", ".sqlite",
]);

const MAX_BYTES = 2 * 1024 * 1024;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const findings = [];
let scanned = 0;

for (const file of files) {
  const dot = file.lastIndexOf(".");
  const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "";
  if (BINARY_EXT.has(ext)) continue;
  let buf;
  try {
    buf = readFileSync(file);
  } catch {
    continue;
  }
  if (buf.length > MAX_BYTES || buf.includes(0)) continue;
  scanned += 1;
  const softExempt = SOFT_EXEMPT.some((re) => re.test(file));
  const lines = buf.toString("utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.includes("pragma: allowlist secret")) continue;
    for (const [name, re] of HARD_RULES) {
      if (re.test(line)) findings.push(`${file}:${i + 1}: [${name}]`);
    }
    if (!softExempt) {
      for (const [name, re] of SOFT_RULES) {
        if (re.test(line)) findings.push(`${file}:${i + 1}: [${name}]`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error(`SECRETS SCAN FAILED（${findings.length} 处）：`);
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`SECRETS SCAN PASS：扫描 ${scanned} 个 git 跟踪文本文件，未发现密钥形态。`);
