// TASK-06A：TOTP 引擎测试（RFC 6238 官方向量 + 窗口/重放/Base32 边界）
import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generate,
  generateTotpSecret,
  otpauthUri,
  stepOf,
  totpCodeAt,
  verify,
} from "./totp";

// RFC 6238 §B.1 SHA-1 测试种子：ASCII "12345678901234567890" 的 Base32
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("totp：RFC 6238 官方向量（6 位取 8 位向量末 6 位）", () => {
  it.each([
    [59, "287082"], // 8位 94287082
    [1_111_111_109, "081804"], // 8位 07081804
    [1_111_111_111, "050471"], // 8位 14050471
    [1_234_567_890, "005924"], // 8位 89005924
    [2_000_000_000, "279037"], // 8位 69279037
  ])("T=%d → %s", async (t, expected) => {
    expect(await generate(RFC_SECRET, t * 1000)).toBe(expected);
  });
});

describe("totp：Base32（RFC 4648）", () => {
  it("编码 20 字节 → 32 字符（无 padding），往返一致", () => {
    const bytes = Uint8Array.from({ length: 20 }, (_, i) => (i * 7) % 256);
    const encoded = base32Encode(bytes);
    expect(encoded).toHaveLength(32);
    expect(encoded).not.toContain("=");
    expect([...base32Decode(encoded)]).toEqual([...bytes]);
  });

  it("容忍小写与 padding；非法字符抛错", () => {
    expect([...base32Decode("gezdgnbv======")]).toEqual([
      ...base32Decode("GEZDGNBV"),
    ]);
    expect(() => base32Decode("INVALID_1")).toThrow();
  });

  it("generateTotpSecret 产出 32 字符且可解码为 20 字节", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect(base32Decode(secret)).toHaveLength(20);
  });
});

describe("totp：窗口容差与防重放", () => {
  it("验证码在相邻步（±1×30s）内仍可验证，返回命中的原始 step", async () => {
    const now = 1_794_700_000_000;
    const step = stepOf(now);
    const code = await totpCodeAt(RFC_SECRET, step);
    // 当前步、前一步时间点、后一步时间点均通过
    expect((await verify(RFC_SECRET, code, now)).step).toBe(step);
    expect((await verify(RFC_SECRET, code, now + 30_000)).step).toBe(step);
    expect((await verify(RFC_SECRET, code, now - 30_000)).step).toBe(step);
    // 超出窗口（+2 步 = 60s）拒绝
    expect((await verify(RFC_SECRET, code, now + 60_000)).ok).toBe(false);
    // window=0 严格模式：仅当前步
    expect((await verify(RFC_SECRET, code, now, 0)).ok).toBe(true);
    expect((await verify(RFC_SECRET, code, now + 30_000, 0)).ok).toBe(false);
  });

  it("防重放判定：同一验证码第二次使用 step ≤ last_used_step 被拒", async () => {
    const now = 1_794_700_000_000;
    const code = await generate(RFC_SECRET, now);
    const first = await verify(RFC_SECRET, code, now);
    expect(first.ok).toBe(true);
    const lastUsed = first.step as number;
    // 调用方规则：step <= last_used → 拒绝（同码重放）
    expect((first.step as number) > lastUsed).toBe(false);
    // 换一步的新码则通过
    const nextCode = await generate(RFC_SECRET, now + 30_000);
    const second = await verify(RFC_SECRET, nextCode, now + 30_000);
    expect(second.ok).toBe(true);
    expect((second.step as number) > lastUsed).toBe(true);
  });

  it("错误验证码与非法格式拒绝", async () => {
    const now = 1_794_700_000_000;
    const code = await generate(RFC_SECRET, now);
    const wrong = code.startsWith("0")
      ? `1${code.slice(1)}`
      : `0${code.slice(1)}`;
    expect((await verify(RFC_SECRET, wrong, now)).ok).toBe(false);
    expect((await verify(RFC_SECRET, "12345", now)).ok).toBe(false);
    expect((await verify(RFC_SECRET, "abcdef", now)).ok).toBe(false);
  });
});

describe("totp：otpauth URI", () => {
  it("扫码 URI 携带 secret/issuer/6位/30s 参数", () => {
    const uri = otpauthUri(RFC_SECRET, "admin@example.com");
    expect(uri.startsWith("otpauth://totp/Property%20Radar:")).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("algorithm=SHA1");
  });
});
