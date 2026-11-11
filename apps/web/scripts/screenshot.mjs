/**
 * TASK-01B 验收截图脚本（Commit 3 交付物）
 *
 * 流程：
 *   1. 以 PUBLIC_DEMO_DATA=1 构建 @property-radar/web（演示数据红线：仅演示构建注入数据）；
 *   2. 自管理启动 `astro preview`（端口 4321，直接以 node 拉起，便于收尾终止）；
 *   3. 用系统 Edge（playwright-core + channel: "msedge"，不下载浏览器）逐页截图，
 *      输出到仓库根 `.screenshots/`（含 7 张 PRD 指定页面、多视口与加载态）；
 *   4. 每张图断言无横向溢出（scrollWidth <= innerWidth），违反则以非 0 退出码结束；
 *   5. finally 收尾：关闭浏览器、终止 preview，避免端口残留。
 *
 * 注意：本文件按仓库 eslint 的 .mjs 全局白名单编写——没有 setTimeout / document /
 * window 全局：延时用 node:timers/promises，浏览器侧取值用字符串表达式 evaluate。
 */
import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const outputDir = join(repoRoot, ".screenshots");
const baseUrl = "http://localhost:4321";
const astroCli = join(webRoot, "node_modules", "astro", "astro.js");

/** 截图清单：PRD 指定 7 页（390 基准）+ 多视口 + 后台抽屉 + 加载态 */
const shots = [
  { file: "01-home-390.png", path: "/", width: 390, height: 844 },
  { file: "02-regions-390.png", path: "/regions", width: 390, height: 844 },
  {
    file: "03-community-390.png",
    path: "/community?id=qingchuan-huayuan",
    width: 390,
    height: 844,
  },
  { file: "04-watch-390.png", path: "/watch", width: 390, height: 844 },
  { file: "05-login-390.png", path: "/login", width: 390, height: 844 },
  { file: "06-events-390.png", path: "/events", width: 390, height: 844 },
  { file: "07-admin-390.png", path: "/admin", width: 390, height: 844 },
  {
    file: "08-admin-1440.png",
    path: "/admin",
    width: 1440,
    height: 900,
    fullPage: false,
    clickFirstRow: true,
  },
  { file: "09-home-360.png", path: "/", width: 360, height: 780 },
  { file: "10-home-375.png", path: "/", width: 375, height: 812 },
  { file: "11-home-430.png", path: "/", width: 430, height: 932 },
  {
    file: "12-briefing-loading-390.png",
    path: "/briefing",
    width: 390,
    height: 844,
    fullPage: false,
    quick: true,
  },
];

/** 读取 PNG 头部获取真实像素尺寸（IHDR：宽 16-19、高 20-23 字节，大端） */
const pngSize = (file) => {
  const buf = readFileSync(file);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
};

/** 探测端口是否已有服务（避免残留进程导致构建内容与截图不一致） */
const portBusy = async () => {
  try {
    const res = await fetch(`${baseUrl}/`);
    return res.ok;
  } catch {
    return false;
  }
};

/** 等待 preview 就绪（最长约 30s） */
const waitReady = async () => {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // 服务未就绪，继续轮询
    }
    await sleep(1000);
  }
  throw new Error("preview 启动超时（30s 内未响应）");
};

const main = async () => {
  if (!existsSync(astroCli)) {
    throw new Error(`未找到 astro CLI：${astroCli}，请先 pnpm install`);
  }

  // ===== 1. 演示数据构建 =====
  console.log("[截图] 以 PUBLIC_DEMO_DATA=1 构建 @property-radar/web …");
  execSync("pnpm --filter @property-radar/web build", {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PUBLIC_DEMO_DATA: "1" },
  });

  if (await portBusy()) {
    throw new Error(`端口 4321 已被占用：请先释放旧的 preview 进程再重跑脚本`);
  }

  // ===== 2. 自管理 preview 生命周期 =====
  console.log("[截图] 启动 astro preview（端口 4321）…");
  const preview = spawn(
    process.execPath,
    [astroCli, "preview", "--port", "4321"],
    {
      cwd: webRoot,
      stdio: "ignore",
    },
  );
  let browser = null;
  const violations = [];

  try {
    await waitReady();
    browser = await chromium.launch({ channel: "msedge", headless: true });
    // deviceScaleFactor 取默认 1，PNG 像素宽度与视口宽度一致，便于验收核对
    const context = await browser.newContext();
    const page = await context.newPage();

    mkdirSync(outputDir, { recursive: true });
    // 清理历史截图，保证交付清单与本次运行一致
    for (const name of readdirSync(outputDir)) {
      if (name.endsWith(".png")) rmSync(join(outputDir, name));
    }

    for (const shot of shots) {
      await page.setViewportSize({ width: shot.width, height: shot.height });
      const url = `${baseUrl}${shot.path}`;
      // 加载态截图：抢在 700ms 骨架切换前抓取，其余页面等网络空闲后稳定 500ms
      await page.goto(url, {
        waitUntil: shot.quick ? "domcontentloaded" : "networkidle",
      });
      await sleep(shot.quick ? 150 : 500);

      if (shot.clickFirstRow) {
        await page.click("tr[data-admin-row]");
        await sleep(400);
      }

      // 横向溢出断言（字符串表达式在浏览器上下文求值，避免 .mjs 全局白名单问题）
      const metrics = await page.evaluate(
        "({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })",
      );
      if (metrics.sw > metrics.iw) {
        violations.push(
          `${shot.file}: scrollWidth=${metrics.sw} > innerWidth=${metrics.iw}`,
        );
      }

      const file = join(outputDir, shot.file);
      await page.screenshot({ path: file, fullPage: shot.fullPage !== false });
      const { w, h } = pngSize(file);
      console.log(`[截图] ${shot.file} — ${w}x${h}（${shot.path}）`);
    }
  } finally {
    await browser?.close();
    preview.kill();
  }

  // ===== 3. 验收断言 =====
  const files = readdirSync(outputDir).filter((name) => name.endsWith(".png"));
  console.log(`[截图] 共产出 ${files.length} 张 PNG → ${outputDir}`);
  if (files.length < 11) {
    throw new Error(`截图数量不足：要求 ≥ 11 张，实际 ${files.length} 张`);
  }
  if (violations.length > 0) {
    console.error("[断言失败] 页面存在横向溢出：");
    violations.forEach((line) => console.error(`  - ${line}`));
    process.exitCode = 1;
    return;
  }
  console.log("[断言] 全部页面 scrollWidth <= innerWidth，无横向溢出");
};

await main();
