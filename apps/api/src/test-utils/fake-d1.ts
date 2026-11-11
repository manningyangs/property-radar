// 测试专用：用 node:sqlite（内存库）模拟 D1Database 的 prepare/bind/all/first/run 子集。
// 仅测试工程（tsconfig.test.json）编译；Worker 运行时使用真实 D1 绑定。
import type { D1Database } from "@cloudflare/workers-types";
import type { DatabaseSync } from "node:sqlite";

type SqlParam = string | number | bigint | null | Uint8Array;

/** D1 允许绑定 boolean（由 JS 层传入时转 0/1），node:sqlite 只接受基本类型 */
function normalize(v: unknown): SqlParam {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v as SqlParam;
}

export function createFakeD1(sqlite: DatabaseSync): D1Database {
  function makeStmt(sql: string, params: unknown[]) {
    const args = () => params.map(normalize);
    return {
      bind: (...next: unknown[]) => makeStmt(sql, next),
      all: async <T>() => ({
        results: sqlite.prepare(sql).all(...args()) as T[],
        success: true,
        meta: { duration: 0, changes: 0, last_row_id: 0 },
      }),
      first: async <T>() =>
        (sqlite.prepare(sql).get(...args()) ?? null) as T | null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args());
        return {
          results: [],
          success: true,
          meta: {
            duration: 0,
            changes: Number(info.changes),
            last_row_id: Number(info.lastInsertRowid),
          },
        };
      },
      raw: async <T>() => sqlite.prepare(sql).all(...args()) as T[],
    };
  }

  const database = {
    prepare: (sql: string) => makeStmt(sql, []),
  };
  return database as unknown as D1Database;
}
