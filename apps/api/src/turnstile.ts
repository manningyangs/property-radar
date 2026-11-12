// TASK-02C：Cloudflare Turnstile 服务端校验（PRD §7.1 OTP 流程步骤 2，免费版反滥用）。
// 密钥未配置时直接 503（绝不静默放行）；网络/非 2xx 视为未通过。
import { errors } from "./errors";
import { type Env } from "./env";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function verifyTurnstile(
  env: Env,
  token: string,
  remoteIp: string,
): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) throw errors.unavailable("人机验证服务未配置");
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteIp && remoteIp !== "unknown") form.append("remoteip", remoteIp);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  } catch {
    return false;
  }
}
