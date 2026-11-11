// TASK-02B：按 IP 的固定窗口限流（Worker 内存级，实例内有效；免费额度内零依赖）

export interface RateLimitOptions {
  /** 窗口内允许的请求数 */
  max: number;
  /** 窗口秒数 */
  windowSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** 触发限流时需等待的秒数 */
  retryAfterSec: number;
}

interface Bucket {
  count: number;
  resetAtMs: number;
}

/** 超过该数量即清理过期桶，避免长期运行内存增长 */
const MAX_BUCKETS = 2000;

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  check(key: string, opts: RateLimitOptions): RateLimitResult {
    const now = Date.now();
    if (this.buckets.size > MAX_BUCKETS) {
      for (const [k, b] of this.buckets) {
        if (b.resetAtMs <= now) this.buckets.delete(k);
      }
    }
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAtMs <= now) {
      this.buckets.set(key, {
        count: 1,
        resetAtMs: now + opts.windowSec * 1000,
      });
      return { allowed: true, remaining: opts.max - 1, retryAfterSec: 0 };
    }
    bucket.count += 1;
    if (bucket.count > opts.max) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAtMs - now) / 1000)),
      };
    }
    return {
      allowed: true,
      remaining: Math.max(0, opts.max - bucket.count),
      retryAfterSec: 0,
    };
  }
}

export function clientIp(
  getHeader: (name: string) => string | undefined,
): string {
  const cf = getHeader("cf-connecting-ip");
  if (cf) return cf;
  const xff = getHeader("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return "unknown";
}
