// TASK-08C R8 静态检查：游客可见页面/布局若引用任何 /me/* 鉴权端点封装，
// 必须同时以 hasSessionHint 门控（游客零 /me 请求、零 401 噪音）。
// 运行时验证见 T10 浏览器实测证据（Network 面板）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** api.ts 中指向 /me/* 的封装函数（新增鉴权封装时同步维护本清单） */
const ME_ENDPOINT_FNS = [
  "listEvents",
  "getUnreadEventCount",
  "markEventRead",
  "listWatchItems",
  "createWatchItem",
  "patchWatchItem",
  "deleteWatchItem",
  "listRules",
  "createRule",
  "patchRule",
  "deleteRule",
  "getMe",
  "exportData",
  "deleteAccount",
  "createCityCoverageRequest",
];

/** 游客可直接访问的页面与全局布局（相对本文件） */
const GUEST_SOURCES = [
  "../pages/index.astro",
  "../pages/regions.astro",
  "../pages/region.astro",
  "../pages/communities.astro",
  "../pages/community.astro",
  "../pages/cities.astro",
  "../pages/methodology.astro",
  "../layouts/AppShell.astro",
];

describe("R8 游客零鉴权噪音（静态检查）", () => {
  it.each(GUEST_SOURCES)(
    "%s 引用 /me 端点必须经 hasSessionHint 门控",
    (rel) => {
      const source = readFileSync(new URL(rel, import.meta.url), "utf8");
      const used = ME_ENDPOINT_FNS.filter((fn) =>
        new RegExp(`\\b${fn}\\b`).test(source),
      );
      if (used.length === 0) return;
      expect(
        source.includes("hasSessionHint"),
        `${rel} 使用了鉴权封装 ${used.join(", ")} 但未导入 hasSessionHint 门控`,
      ).toBe(true);
    },
  );

  it("游客页面不得直接书写 /me/ 路径字面量（必须走 api.ts 封装）", () => {
    for (const rel of GUEST_SOURCES) {
      const source = readFileSync(new URL(rel, import.meta.url), "utf8");
      const scriptPart = source.slice(source.indexOf("<script>"));
      expect(
        /["'`]\/?api\/v1\/me\//.test(scriptPart) ||
          /["'`]\/me\//.test(scriptPart),
        `${rel} 存在 /me/ 字面量路径`,
      ).toBe(false);
    }
  });
});
