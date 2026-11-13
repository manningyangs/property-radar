// Worker 入口：Cloudflare 按 wrangler.jsonc 提供 D1 绑定（DB_PUBLIC / DB_PRIVATE）
import { createApp } from "./app";
import { sendDailyDigest } from "./digest";
import type { Env } from "./env";
import { logError } from "./log";
import { evaluateSystemEvents } from "./rules-engine";

const app = createApp();

// TASK-05A/05B §6.6：Worker 定时触发（与 wrangler.jsonc crons 字符串保持一致）——
// UTC 00:30 = 北京 08:30 事件评估（evaluateSystemEvents）；
// UTC 23:30 = 北京 07:30 每日摘要（sendDailyDigest）。
const CRON_DAILY_DIGEST = "30 23 * * *";

async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // 两条 cron 独立 waitUntil + 独立 catch：任一任务失败/未完成都不阻塞另一任务（§6.6）
  if (event.cron === CRON_DAILY_DIGEST) {
    ctx.waitUntil(
      sendDailyDigest(env, new Date())
        .then((result) => {
          console.log(
            JSON.stringify({ request_id: "cron-daily-digest", ...result }),
          );
        })
        .catch((err: unknown) => {
          logError({
            request_id: "cron-daily-digest",
            message: err instanceof Error ? err.message : String(err),
          });
        }),
    );
    return;
  }
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
