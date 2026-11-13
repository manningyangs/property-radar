// Worker 入口：Cloudflare 按 wrangler.jsonc 提供 D1 绑定（DB_PUBLIC / DB_PRIVATE）
import { createApp } from "./app";
import type { Env } from "./env";
import { logError } from "./log";
import { evaluateSystemEvents } from "./rules-engine";

const app = createApp();

// TASK-05A §6.6：Worker 定时触发（wrangler.jsonc crons：UTC 00:30 = 北京 08:30）——
// 与 POST /internal/events/evaluate 共用 evaluateSystemEvents（更新延迟/数据异常评估）。
async function scheduled(
  _event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  ctx.waitUntil(
    evaluateSystemEvents(env, new Date()).catch((err: unknown) => {
      logError({
        request_id: "cron-events-evaluate",
        message: err instanceof Error ? err.message : String(err),
      });
    }),
  );
}

export default { fetch: app.fetch, scheduled };
