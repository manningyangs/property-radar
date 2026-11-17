// TASK-08C R8：登录态客户端提示（localStorage 布尔标记）。
// 会话本身由 HttpOnly Cookie 承载，前端无法读取；游客页面据此提示决定是否
// 调用 /me/* 鉴权端点，消除游客全链路 401 噪音。提示过期无害：
// /me/* 页面仍按 Cookie 真实鉴权，本标记只用于“要不要发这个请求”。

export const SESSION_HINT_KEY = "pr_session_hint";

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage !== "undefined"
      ? globalThis.localStorage
      : null;
  } catch {
    return null;
  }
}

/** 登录成功后调用 */
export function setSessionHint(): void {
  storage()?.setItem(SESSION_HINT_KEY, "1");
}

/** 退出/注销后调用 */
export function clearSessionHint(): void {
  storage()?.removeItem(SESSION_HINT_KEY);
}

/** 游客页面调用：false 时不得发起任何 /me/* 请求 */
export function hasSessionHint(): boolean {
  return storage()?.getItem(SESSION_HINT_KEY) === "1";
}
