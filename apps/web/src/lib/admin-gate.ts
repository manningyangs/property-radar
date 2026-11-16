// TASK-06D：管理端 MFA 门禁状态机（与 06C sources.astro 内嵌逻辑同构，抽为共享供
// /admin、/admin/jobs、/admin/quality 三页复用）。
// 流程：getMe（401 由 api.ts 统一跳 /login?next=）→ adminMfaStatus →
//   session_verified → 隐藏面板并回调 onReady；
//   confirmed（已绑未验）→ TOTP 输入；未绑定 → setup 引导（生成密钥 → 输入口令验证）。
// 依赖页面存在 AdminMfaGate.astro 的 [data-mfa*] 面板与 [data-main] 主区容器。
import {
  adminMfaSetup,
  adminMfaStatus,
  adminMfaVerify,
  ApiError,
  getMe,
} from "./api";

function $el<T extends Element>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function show(sel: string, visible: boolean): void {
  const el = $el<HTMLElement>(sel);
  if (el) el.hidden = !visible;
}

function setText(sel: string, text: string): void {
  const el = $el<HTMLElement>(sel);
  if (el) el.textContent = text;
}

function val(sel: string): string {
  return $el<HTMLInputElement>(sel)?.value.trim() ?? "";
}

function mfaFail(message: string): void {
  const el = $el<HTMLElement>("[data-mfa-error]");
  if (el) {
    el.textContent = message;
    el.hidden = false;
  }
}

/** 门禁就绪回调（进入主区后触发页面数据加载） */
export function initAdminGate(onReady: () => void | Promise<void>): void {
  async function enterMain(): Promise<void> {
    show("[data-mfa]", false);
    show("[data-main]", true);
    await onReady();
  }

  async function boot(): Promise<void> {
    try {
      await getMe(); // 401 已由 api.ts 统一跳转 /login?next=
      const st = await adminMfaStatus();
      if (st.session_verified) {
        await enterMain();
        return;
      }
      show("[data-mfa]", true);
      if (st.confirmed) {
        show("[data-mfa-code]", true);
      } else {
        show("[data-mfa-setup]", true);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // 跳转中
      mfaFail(err instanceof Error ? err.message : String(err));
      show("[data-mfa]", true);
    }
  }

  $el<HTMLButtonElement>("[data-mfa-gen]")?.addEventListener(
    "click",
    async () => {
      try {
        const setup = await adminMfaSetup();
        setText("[data-mfa-secret]", setup.secret);
        setText("[data-mfa-uri]", setup.otpauth_uri);
        show("[data-mfa-secret-box]", true);
        show("[data-mfa-code]", true);
        show("[data-mfa-setup]", false);
      } catch (err) {
        mfaFail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  $el<HTMLButtonElement>("[data-mfa-verify]")?.addEventListener(
    "click",
    async () => {
      const code = val("[data-mfa-input]");
      if (!/^\d{6}$/.test(code)) {
        mfaFail("请输入 6 位数字动态口令");
        return;
      }
      try {
        await adminMfaVerify(code);
        await enterMain();
      } catch (err) {
        mfaFail(err instanceof Error ? err.message : String(err));
      }
    },
  );

  void boot();
}
