/**
 * 房价雷达 Service Worker（TASK-01C）
 * PRD V1.2 第 1216–1222 行的缓存红线：
 *  - 只缓存公开静态文件（/_astro/、/icons/、manifest）与公开页面（/、/regions、/communities、/community）；
 *  - 绝不缓存账户私有响应、OTP、用户监控/规则/事件等敏感数据（/api/*、私有路由一律直连网络）；
 *  - 页面展示缓存时间（meta 缓存记录 cachedAt）；
 *  - 登出时通过 PURGE_PRIVATE 消息清理页面缓存与 meta。
 */

const VERSION = "20261113.1";
const STATIC_CACHE = `pr-static-${VERSION}`;
const PAGE_CACHE = `pr-pages-${VERSION}`;
/** meta 缓存跨版本保留（存缓存时间），仅在 PURGE_PRIVATE 或 activate 显式清理逻辑外保护 */
const META_CACHE = "pr-meta-v1";

const PRECACHE = ["/", "/offline.html", "/manifest.webmanifest"];

/** 允许离线回退的公开页面（首屏 + 三个公开 tab + 小区详情） */
const PUBLIC_PAGES = ["/", "/regions", "/communities", "/community"];

/** 私有前缀：永不缓存、永不读缓存，离线时直接回 offline 页 */
const PRIVATE_PREFIXES = [
  "/login",
  "/account",
  "/watch",
  "/rules",
  "/events",
  "/admin",
  "/briefing",
  "/api",
];

const NETWORK_TIMEOUT_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await cache.addAll(PRECACHE);
        // 首次访问时页面资产（外部 CSS 等）在 SW 接管前加载，不经 fetch 事件，
        // 因此在安装阶段就从预缓存首页的 HTML 中提取引用一并入缓存。
        const home = await cache.match("/");
        if (home) await precacheAssets(home.clone());
      } catch {
        /* 单个预缓存失败不阻塞安装 */
      }
      await writeMeta();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(
            (key) =>
              (key.startsWith("pr-static-") ||
                key.startsWith("pr-pages-")) &&
              key !== STATIC_CACHE &&
              key !== PAGE_CACHE,
          )
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  const port = event.ports && event.ports[0];
  const reply = (payload) => {
    if (port) port.postMessage(payload);
    else event.source?.postMessage(payload);
  };
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "GET_META") {
    event.waitUntil(
      readMeta().then((meta) => {
        reply({ type: "META", meta });
      }),
    );
    return;
  }
  if (data.type === "PURGE_PRIVATE") {
    event.waitUntil(
      (async () => {
        await caches.delete(PAGE_CACHE);
        await caches.delete(META_CACHE);
        reply({ type: "PURGED" });
      })(),
    );
  }
});

/* ============ TASK-05C：Web Push 通知（spec §5.2） ============ */

// 服务端下发 payload：{ title, body, url, tag }（push.ts buildPushPayload 同源拼装）
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let data = null;
      try {
        data = event.data ? event.data.json() : null;
      } catch {
        data = null; // 解析失败走通用标题，不白屏
      }
      const title =
        (data && typeof data.title === "string" && data.title) || "房价雷达";
      const body =
        data && typeof data.body === "string" && data.body
          ? data.body
          : "有新的监控事件，点击查看。";
      const tag =
        data && typeof data.tag === "string" && data.tag
          ? data.tag
          : "property-radar-event";
      const url = data && typeof data.url === "string" ? data.url : "/events";
      await self.registration.showNotification(title, {
        body,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag,
        data: { url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = typeof data.url === "string" ? data.url : "/events";
  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // 已有窗口：聚焦并跳转到事件页；否则开新窗
      for (const client of allClients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // API 响应（含 OTP、账户、监控等私有数据）绝不缓存
  if (path.startsWith("/api/")) return;

  // 私有路由：network-only，离线回 offline 页
  if (PRIVATE_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    event.respondWith(networkOnly(request));
    return;
  }

  // 导航请求：公开页面 network-first + 缓存回退（标注缓存时间由页面脚本读取 meta）
  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request, path));
    return;
  }

  // 带内容哈希的构建产物：cache-first
  if (
    path.startsWith("/_astro/") ||
    path.startsWith("/icons/") ||
    path === "/manifest.webmanifest"
  ) {
    event.respondWith(cacheFirst(request));
  }
  // 其余静态资源（字体、favicon 等）：默认走网络，不缓存
});

/* ============ 策略实现 ============ */

async function handleNavigation(request, path) {
  const isPublic = PUBLIC_PAGES.some(
    (page) => path === page || (page !== "/" && path.startsWith(`${page}/`)),
  );
  if (!isPublic) return networkOnly(request);

  try {
    const response = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (response.ok) {
      const cache = await caches.open(PAGE_CACHE);
      cache.put(request, response.clone());
      await writeMeta();
      // 关键：首访时页面 CSS/资产在 SW 接管前已加载、未经 fetch 事件，
      // 需从 HTML 中提取引用一并入缓存，保证「下一次离线」页面带样式。
      await precacheAssets(response.clone());
      return response;
    }
    // 网络返回 5xx：尝试缓存
    const cached = await caches.match(request);
    if (cached) return cached;
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return offlineFallback();
  }
}

/** 从已缓存页面的 HTML 中提取 /_astro/、/icons/、manifest 引用并写入静态缓存 */
async function precacheAssets(htmlResponse) {
  try {
    const html = await htmlResponse.text();
    const urls = new Set();
    const pattern =
      /(?:href|src)="(\/_astro\/[^"]+|\/icons\/[^"]+|\/manifest\.webmanifest)"/g;
    for (const match of html.matchAll(pattern)) {
      urls.add(match[1]);
    }
    if (urls.size === 0) return;
    const cache = await caches.open(STATIC_CACHE);
    await Promise.all(
      [...urls].map(async (url) => {
        if (await caches.match(url)) return;
        const asset = await fetch(url);
        if (asset.ok) await cache.put(url, asset);
      }),
    );
  } catch {
    /* 资产预取失败不阻塞页面响应 */
  }
}

async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch {
    return offlineFallback();
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function offlineFallback() {
  // 优先返回预缓存的离线页（保留 200 状态，导航请求可正常展示内容）
  const page = await caches.match("/offline.html");
  if (page) return page;
  return new Response("离线且无缓存", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("network timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/* ============ 缓存时间 meta ============ */

async function writeMeta() {
  try {
    const cache = await caches.open(META_CACHE);
    await cache.put(
      "/__meta__",
      new Response(
        JSON.stringify({ cachedAt: new Date().toISOString(), version: VERSION }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
  } catch {
    /* meta 写入失败不影响缓存本身 */
  }
}

async function readMeta() {
  try {
    const cache = await caches.open(META_CACHE);
    const response = await cache.match("/__meta__");
    if (!response) return null;
    return await response.json();
  } catch {
    return null;
  }
}
