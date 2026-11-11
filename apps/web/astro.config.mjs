// @ts-check
import { defineConfig } from "astro/config";

// V1 前端托管于 Cloudflare Pages（静态输出 + Worker API 分离）；
// SSR/适配器在阶段 2 按需引入。
export default defineConfig({
  output: "static",
  server: { port: 4321 },
  compressHTML: true,
});
