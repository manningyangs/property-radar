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
  for (const migration of migrations) {
    executor.exec(migration.sql);
  }
  return migrations.map((m) => m.name);
}
