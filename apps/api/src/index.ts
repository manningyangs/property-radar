// Worker 入口：Cloudflare 按 wrangler.jsonc 提供 D1 绑定（DB_PUBLIC / DB_PRIVATE）
import { createApp } from "./app";

const app = createApp();

export default app;
