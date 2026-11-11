// 测试专用：内存双库（public/private）+ 迁移 + 用户/会话种子
import { DatabaseSync } from "node:sqlite";
import { applyMigrations } from "@property-radar/migrations";
import { sha256Hex } from "../auth";
import type { Env } from "../env";
import { createFakeD1 } from "./fake-d1";

export interface TestContext {
  env: Env;
  pub: DatabaseSync;
  priv: DatabaseSync;
}

/** 创建已应用全部迁移的 Public/Private 内存库 */
export function createTestEnv(): TestContext {
  const pub = new DatabaseSync(":memory:");
  const priv = new DatabaseSync(":memory:");
  pub.exec("PRAGMA foreign_keys = ON;");
  priv.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(pub, "public", "up");
  applyMigrations(priv, "private", "up");
  return {
    env: { DB_PUBLIC: createFakeD1(pub), DB_PRIVATE: createFakeD1(priv) },
    pub,
    priv,
  };
}

/** 种子：用户 + 有效期 1 天的会话，返回可直接用于 Cookie 头的 token */
export async function seedUser(
  priv: DatabaseSync,
  userId: string,
  email: string,
  token: string,
): Promise<void> {
  priv
    .prepare(
      "INSERT INTO users (user_id, email_normalized, email_verified_at) VALUES (?, ?, datetime('now'))",
    )
    .run(userId, email);
  const tokenHash = await sha256Hex(token);
  priv
    .prepare(
      `INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
       VALUES (?, ?, ?, datetime('now', '+1 day'))`,
    )
    .run(`sess_${userId}`, userId, tokenHash);
}

export function authCookie(token: string): string {
  return `pr_session=${token}`;
}
