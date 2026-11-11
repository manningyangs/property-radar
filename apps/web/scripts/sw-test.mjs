/**
 * TASK-01C 验收脚本：PWA / Service Worker / 离线缓存策略
 *
 * PRD V1.2 第 1216–1222 行验收标准：
 *   1. Manifest 与图标可安装（静态资源 200 + PNG 有效）；
 *   2. SW 注册成功并记录缓存时间（GET_META → cachedAt）；
 *   3. 离线时公开首页显示最近缓存内容，并明确标注缓存时间（截图 13-offline-390.png）；
 *   4. 离线访问私有页面（/login）回离线提示页，绝不读缓存；
 *   5. 登出清理（__prPurgePrivateCache）后页面缓存与 meta 全部移除。
 *
 * 手法说明：
 *   - 先在线预热（构建 + preview + 打开首页注册 SW、写入缓存与 meta）；
 *   - 随后「真杀 preview 进程 + context.setOffline(true)」双保险模拟离线——
 *     不依赖 CDP 离线仿真是否穿透 Service Worker；
 *   - finally 收尾浏览器与 preview，避免端口残留。
 *
 * eslint 注意：与 screenshot.mjs 相同，.mjs 不含 window/document 全局，
 * 浏览器侧逻辑一律以字符串表达式 evaluate。
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "..", "..");
const outputDir = join(repoRoot, ".screenshots");
const baseUrl = "http://localhost:4323";
const astroCli = join(webRoot, "node_modules", "astro", "astro.js");

const failures = [];
const assert = (cond, message) => {
  if (cond) {
    console.log(`[通过] ${message}`);
  } else {
    failures.push(message);
    console.error(`[失败] ${message}`);
  }
};

const portBusy = async () => {
  try {
    const res = await fetch(`${baseUrl}/`);
    return res.ok;
  } catch {
    return false;
  }
};

const waitReady = async () => {
  for (let i = 0; i < 30; i += 1) {
    try {
      const res = await fetch(`${baseUrl}/`);
      if (res.ok) return;
    } catch {
      // 未就绪，继续轮询
    }
    await sleep(1000);
  }
  throw new Error("preview 启动超时（30s 内未响应）");
};

/** 等待 port 释放（kill 之后确认服务真的死了） */
const waitDead = async () => {
  for (let i = 0; i < 20; i += 1) {
    if (!(await portBusy())) return;
    await sleep(300);
  }
  throw new Error("preview 未能在 6s 内退出");
};

/** 带重试地在页面上下文执行字符串表达式（SW claim/控制器就绪存在竞态） */
const retryEvaluate = async (page, expression, tries = 12) => {
  let last = null;
  for (let i = 0; i < tries; i += 1) {
    last = await page.evaluate(expression);
    if (last !== null && last !== undefined && last !== "no-controller") {
      return last;
    }
    await sleep(500);
  }
  return last;
};

const main = async () => {
  if (!existsSync(astroCli)) {
    throw new Error(`未找到 astro CLI：${astroCli}，请先 pnpm install`);
  }

  // ===== 1. 构建（含演示数据，与 TASK-01B 截图口径一致） =====
  console.log("[01C] 以 PUBLIC_DEMO_DATA=1 构建 @property-radar/web …");
  execSync("pnpm --filter @property-radar/web build", {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, PUBLIC_DEMO_DATA: "1" },
  });

  if (await portBusy()) {
    throw new Error(`端口 4323 已被占用：请先释放旧的 preview 进程再重跑脚本`);
  }

  // ===== 2. 启动 preview =====
  console.log("[01C] 启动 astro preview（端口 4323）…");
  const preview = spawn(
    process.execPath,
    [astroCli, "preview", "--port", "4323"],
    { cwd: webRoot, stdio: "ignore" },
  );
  let browser = null;
  let context = null;
  let offlineMode = false;

  try {
    await waitReady();

    // ===== 3. 静态资源检查（Manifest / 图标 / SW / 离线页） =====
    const staticAssets = [
      "/manifest.webmanifest",
      "/sw.js",
      "/offline.html",
      "/icons/icon-192.png",
      "/icons/icon-512.png",
      "/icons/maskable-512.png",
      "/icons/apple-touch-180.png",
    ];
    for (const asset of staticAssets) {
      const res = await fetch(`${baseUrl}${asset}`);
      assert(res.ok, `静态资源 ${asset} 返回 ${res.status}`);
    }
    const manifest = await (
      await fetch(`${baseUrl}/manifest.webmanifest`)
    ).json();
    assert(
      Array.isArray(manifest.icons) && manifest.icons.length >= 3,
      "Manifest 声明 ≥3 个图标（含 maskable）",
    );
    const png = readFileSync(
      join(webRoot, "public", "icons", "maskable-512.png"),
    );
    assert(
      png.subarray(0, 4).toString("hex") === "89504e47" &&
        png.readUInt32BE(16) === 512,
      "maskable-512.png 为有效 512px PNG",
    );

    // ===== 4. 在线预热：注册 SW、写缓存与 meta =====
    browser = await chromium.launch({ channel: "msedge", headless: true });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });

    const meta = await retryEvaluate(
      page,
      `new Promise((resolve) => {
        navigator.serviceWorker.ready.then(() => {
          const controller = navigator.serviceWorker.controller;
          if (!controller) { resolve("no-controller"); return; }
          const channel = new MessageChannel();
          const timer = setTimeout(() => resolve(null), 3000);
          channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data && e.data.meta); };
          controller.postMessage({ type: "GET_META" }, [channel.port2]);
        });
      })`,
    );
    assert(
      meta && typeof meta.cachedAt === "string",
      `SW 已注册并写入缓存时间（cachedAt=${meta && meta.cachedAt}）`,
    );
    const controlled = await page.evaluate(
      "Boolean(navigator.serviceWorker.controller)",
    );
    assert(controlled, "首页已被 Service Worker 控制");

    // ===== 5. 模拟离线：杀 preview + 浏览器离线 =====
    console.log("[01C] 模拟离线（kill preview + setOffline）…");
    preview.kill();
    await waitDead();
    await context.setOffline(true);
    offlineMode = true;

    // 5a. 离线重载公开首页 → 命中缓存 + 显示缓存时间
    await page.reload({ waitUntil: "domcontentloaded" });
    const bannerVisible = await page
      .waitForSelector("[data-pwa-offline]:not([hidden])", { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    assert(bannerVisible, "离线后展示离线横幅");
    const bannerText =
      (await page.textContent("[data-pwa-offline-text]")) ?? "";
    assert(
      bannerText.includes("缓存时间"),
      `离线横幅标注缓存时间：「${bannerText.trim()}」`,
    );
    const homeTitle = await page.title();
    assert(
      homeTitle.includes("房价雷达"),
      `离线时展示最近缓存的首页（title=${homeTitle}）`,
    );
    // 样式断言：页面背景应为设计令牌 --color-bg #f5f7fa（证明外部 CSS 命中缓存）
    const bodyBg = await page.evaluate(
      "getComputedStyle(document.body).backgroundColor",
    );
    assert(
      bodyBg === "rgb(245, 247, 250)",
      `离线首页样式已加载（body background=${bodyBg}）`,
    );
    mkdirSync(outputDir, { recursive: true });
    await page.screenshot({
      path: join(outputDir, "13-offline-390.png"),
      fullPage: false,
    });
    console.log("[01C] 已输出 .screenshots/13-offline-390.png");

    // 5b. 离线访问私有页面 → 离线提示页（不读缓存）
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
    const offlineBody = await page.evaluate("document.body.innerText || ''");
    assert(
      offlineBody.includes("当前无法连接网络"),
      "离线访问 /login 返回离线提示页（私有页面不缓存）",
    );
    const loginPath = await page.evaluate("window.location.pathname");
    assert(loginPath === "/login", `离线回退不改变地址栏（path=${loginPath}）`);

    // ===== 6. 登出清理：私有客户端缓存全部移除 =====
    // 注意：回到缓存的首页（真实应用壳，PwaRuntime 已挂载）执行清理——
    // /login 离线时返回的是独立 offline.html，不带应用脚本。
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
    const purge = await page.evaluate(`(async () => {
      const fn = window.__prPurgePrivateCache;
      if (!fn) return "no-fn";
      await fn();
      const keys = await caches.keys();
      const pages = keys.filter((k) => k.startsWith("pr-pages-"));
      return JSON.stringify({ pages, metaLeft: keys.includes("pr-meta-v1") });
    })()`);
    assert(purge !== "no-fn", "__prPurgePrivateCache 已挂载到 window");
    const purgeResult = purge === "no-fn" ? {} : JSON.parse(purge);
    assert(
      Array.isArray(purgeResult.pages) && purgeResult.pages.length === 0,
      "登出清理后页面缓存（pr-pages-*）已删除",
    );
    assert(
      purgeResult.metaLeft === false,
      "登出清理后缓存时间 meta（pr-meta-v1）已删除",
    );

    await context.setOffline(false);
    offlineMode = false;
  } finally {
    if (offlineMode) {
      await context.setOffline(false).catch(() => {});
    }
    await browser?.close();
    preview.kill();
  }

  // ===== 7. 汇总 =====
  if (failures.length > 0) {
    console.error(`\n[01C] 验收失败：${failures.length} 项未通过`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "\n[01C] PWA 验收全部通过（安装资源 / SW 注册 / 离线缓存+缓存时间 / 私有页不缓存 / 登出清理）",
  );
};

await main();
