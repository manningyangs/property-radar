// TASK-02A：D1 迁移加载器——纯读取 SQL 文件并按序执行，供本地测试与重建流程使用。
// 远端执行走 `wrangler d1 execute`（见 apps/api package.json 脚本），本包不涉及任何凭据。
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 迁移目标库（与 wrangler.jsonc 的 database_name 对应） */
export type DatabaseName = "public" | "private";

/** 迁移方向：up=建表（幂等），down=回滚（幂等） */
export type MigrationDirection = "up" | "down";

/** 最小 SQL 执行接口：node:sqlite 的 DatabaseSync 与测试桩均满足 */
export interface SqlExecutor {
  exec(sql: string): unknown;
}

/** db/migrations 根目录（本包位于 packages/migrations/src） */
export const MIGRATIONS_ROOT = fileURLToPath(
  new URL("../../../db/migrations", import.meta.url),
);

export interface MigrationFile {
  /** 迁移名，如 "0001_init" */
  name: string;
  database: DatabaseName;
  direction: MigrationDirection;
  filePath: string;
  sql: string;
}

/**
 * 列出并读取指定库的全部迁移文件，按文件名（版本号）升序。
 * up 与 down 配对存在；文件缺失时在执行阶段报错。
 */
export function loadMigrations(
  database: DatabaseName,
  direction: MigrationDirection,
): MigrationFile[] {
  const dir = path.join(MIGRATIONS_ROOT, database);
  const suffix = `.${direction}.sql`;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(suffix))
    .sort();
  return files.map((file) => {
    const filePath = path.join(dir, file);
    return {
      name: file.slice(0, -suffix.length),
      database,
      direction,
      filePath,
      sql: readFileSync(filePath, "utf8"),
    };
  });
}

/**
 * 按序执行迁移。SQL 全部为 IF NOT EXISTS / DROP IF EXISTS 幂等语句，
 * 重复运行安全（PRD §TASK-02A「迁移可重复运行」）。
 * down 按版本号**降序**执行：后建的表（FK 子表）先删，
 * 避免删父表时子表外键仍引用已删对象（如 0003 watch_item_groups 引用 0001 watch_items/users）。
 * @returns 已执行的迁移名列表
 */
export function applyMigrations(
  executor: SqlExecutor,
  database: DatabaseName,
  direction: MigrationDirection = "up",
): string[] {
  const migrations = loadMigrations(database, direction);
  if (migrations.length === 0) {
    throw new Error(`没有找到 ${database} 库的 ${direction} 迁移文件`);
  }
  // down 逆序回滚（0003 → 0002 → 0001），保证外键依赖方向正确
  const ordered = direction === "down" ? [...migrations].reverse() : migrations;
  for (const migration of ordered) {
    try {
      executor.exec(migration.sql);
    } catch (e) {
      // TASK-04E 幂等容错指令：文件头 `-- +migrate-idempotent: <错误子串>` 声明时，
      // 执行失败且错误消息包含该子串视为「已应用/已回滚」（SQLite 无 ADD COLUMN IF NOT
      // EXISTS，首个列变更迁移 0004 依赖此保持「迁移可重复运行」不变量）。
      // 指令文件须保持单语句，避免容错吞掉同文件后续真实错误。
      const tolerate = migration.sql
        .match(/^--\s*\+migrate-idempotent:\s*(.+)$/m)?.[1]
        ?.trim();
      if (
        tolerate !== undefined &&
        e instanceof Error &&
        e.message.includes(tolerate)
      ) {
        continue;
      }
      throw e;
    }
  }
  return ordered.map((m) => m.name);
}
