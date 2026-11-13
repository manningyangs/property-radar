// TASK-02A：迁移本地验收测试——up/down 可重复运行、索引覆盖核心查询、
// 外键与唯一约束生效、Public DB 无个人信息（PRD §9.4）。
// 全部在内存库执行；「测试数据」为虚构数据（example.com / TEST-* 代码），仅存在于内存库。
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { applyMigrations, loadMigrations } from "./index";

const PUBLIC_TABLES = [
  "cities",
  "communities",
  "data_sources_public",
  "listing_price_events_public",
  "price_observations",
  "price_snapshots",
  "regions",
  "source_city_coverage",
  "source_field_verifications",
  "source_license_state",
];

const PRIVATE_TABLES = [
  "admin_roles",
  "alert_events",
  "audit_logs",
  "city_coverage_requests",
  "email_otps",
  "email_send_ledger",
  "ingest_batches",
  "ingest_jobs",
  "ingest_nonces",
  "notification_deliveries",
  "notification_preferences",
  "push_subscriptions",
  "sessions",
  "source_approvals",
  "source_health_reports",
  "user_cities",
  "user_consents",
  "users",
  "watch_item_groups",
  "watch_items",
  "watch_rule_settings",
  "watch_rules",
];

/** Public 库禁止出现的个人/账户字段名（§9.4：Public DB 不含用户数据） */
const FORBIDDEN_PUBLIC_COLUMN =
  /(^|_)(email|user|phone|mobile|token|otp|session|consent|password|passwd|id_card|real_name|ip_address|ip_hash)(_|$)/i;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

function tablesOf(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function indexesOf(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'",
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function columnsOf(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

describe("迁移文件加载", () => {
  it("public/private 的 up 与 down 迁移成对且同名", () => {
    for (const db of ["public", "private"] as const) {
      const up = loadMigrations(db, "up");
      const down = loadMigrations(db, "down");
      expect(up.length).toBeGreaterThan(0);
      expect(up.map((m) => m.name)).toEqual(down.map((m) => m.name));
    }
  });

  it("所有 up/down 语句均为幂等写法（IF NOT EXISTS / IF EXISTS）", () => {
    for (const db of ["public", "private"] as const) {
      for (const dir of ["up", "down"] as const) {
        for (const m of loadMigrations(db, dir)) {
          // 剥离 -- 行注释，避免注释中的示例词误报
          const sql = m.sql
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("--"))
            .join("\n");
          const bareCreate = sql.match(/CREATE\s+TABLE\s+(?!IF NOT EXISTS)/i);
          const bareDrop = sql.match(/DROP\s+TABLE\s+(?!IF EXISTS)/i);
          const bareIndex = sql.match(
            /CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF NOT EXISTS)/i,
          );
          expect(bareCreate, `${m.name} 存在非幂等 CREATE TABLE`).toBeNull();
          expect(bareDrop, `${m.name} 存在非幂等 DROP TABLE`).toBeNull();
          expect(bareIndex, `${m.name} 存在非幂等 CREATE INDEX`).toBeNull();
        }
      }
    }
  });
});

describe("Public D1（radar_public）", () => {
  it("up 建出全部 10 张表，且重复执行（幂等）不报错", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    expect(tablesOf(db).sort()).toEqual(PUBLIC_TABLES);
    expect(() => applyMigrations(db, "public", "up")).not.toThrow();
    expect(tablesOf(db).sort()).toEqual(PUBLIC_TABLES);
  });

  it("down 可回滚全部表，重复执行安全；down→up 可重建", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    applyMigrations(db, "public", "down");
    expect(tablesOf(db)).toEqual([]);
    expect(() => applyMigrations(db, "public", "down")).not.toThrow();
    applyMigrations(db, "public", "up");
    expect(tablesOf(db).sort()).toEqual(PUBLIC_TABLES);
  });

  it("索引覆盖 §9.3 公共侧核心查询", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    const idx = indexesOf(db);
    expect(idx).toContain("ix_price_snapshots_core"); // price_snapshots(object_type, object_id, metric_code, stat_date DESC)
    expect(idx).toContain("ix_price_obs_source_stat_obj"); // price_observations(source_id, stat_date, object_id)
    expect(idx).toContain("ix_communities_region_name"); // communities(region_id, name)
    expect(idx).toContain("ux_regions_city_parent_name_level");
    expect(idx).toContain("ux_price_snapshots_key");
  });

  it("外键与唯一约束生效（source_city_coverage 主键、快照唯一键）", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    // 不存在的 source/city 引用被外键拒绝
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_city_coverage (source_id, city_code, object_level, authorization_status) VALUES ('src_x', 'CITY_X', 'city', 'approved_open')",
        )
        .run(),
    ).toThrow();
    // 虚构测试数据写入成功（仅内存库）
    db.prepare(
      "INSERT INTO cities (city_code, name, province_code) VALUES ('TEST-0000', '本地测试城市（虚构）', 'TEST-PR')",
    ).run();
    db.prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_test_local', '本地测试来源（虚构）', 'manual')",
    ).run();
    db.prepare(
      "INSERT INTO source_city_coverage (source_id, city_code, object_level, authorization_status) VALUES ('src_test_local', 'TEST-0000', 'city', 'manual_only')",
    ).run();
    // 同一 (source_id, city_code, object_level) 重复插入被拒
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_city_coverage (source_id, city_code, object_level, authorization_status) VALUES ('src_test_local', 'TEST-0000', 'city', 'approved_open')",
        )
        .run(),
    ).toThrow();
    // 同一（对象, 价格类型, 指标, 日期）快照唯一
    const snap =
      "INSERT INTO price_snapshots (snapshot_id, object_type, object_id, price_type, metric_code, median, stat_date) VALUES (?, 'region', 'TEST-0000', 'listing_ask', 'median_unit_price', 12345, '2026-11-01')";
    db.prepare(snap).run("snap_test_1");
    expect(() => db.prepare(snap).run("snap_test_2")).toThrow();
  });

  it("source_license_state（TASK-04A）：七态 CHECK、日期格式与 source FK 生效", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    // 无父行引用被外键拒绝
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_license_state (source_id, status) VALUES ('src_missing', 'discovered')",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_local', '本地来源（虚构）', 'manual')",
    ).run();
    // 默认 discovered 可插入；非法状态被 CHECK 拒绝
    db.prepare(
      "INSERT INTO source_license_state (source_id) VALUES ('src_local')",
    ).run();
    expect(
      (
        db
          .prepare(
            "SELECT status FROM source_license_state WHERE source_id = 'src_local'",
          )
          .get() as {
          status: string;
        }
      ).status,
    ).toBe("discovered");
    expect(() =>
      db
        .prepare(
          "UPDATE source_license_state SET status = 'maybe_ok' WHERE source_id = 'src_local'",
        )
        .run(),
    ).toThrow();
    // 到期日格式受 GLOB CHECK 约束
    db.prepare(
      "UPDATE source_license_state SET status = 'approved_open', valid_until = '2027-01-01' WHERE source_id = 'src_local'",
    ).run();
    expect(() =>
      db
        .prepare(
          "UPDATE source_license_state SET valid_until = '2027/01/01' WHERE source_id = 'src_local'",
        )
        .run(),
    ).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("source_field_verifications（TASK-04C）：状态/日期 CHECK、source FK、主键唯一生效", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    // 不存在的 source 引用被外键拒绝
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_field_verifications (source_id, field_code, field_label) VALUES ('src_missing', 'f1', '字段一')",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_local', '本地来源（虚构）', 'manual')",
    ).run();
    // 默认 unverified 可插入；非法状态被 CHECK 拒绝
    db.prepare(
      "INSERT INTO source_field_verifications (source_id, field_code, field_label, metric_code) VALUES ('src_local', 'f1', '字段一', 'new_house_price_index')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_field_verifications (source_id, field_code, field_label, status) VALUES ('src_local', 'f2', '字段二', 'maybe')",
        )
        .run(),
    ).toThrow();
    // 空字段编码与非法核验日期被 CHECK 拒绝
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_field_verifications (source_id, field_code, field_label) VALUES ('src_local', '', '空编码')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "UPDATE source_field_verifications SET status = 'verified', verified_at = '2026/11/12' WHERE source_id = 'src_local' AND field_code = 'f1'",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "UPDATE source_field_verifications SET status = 'verified', verified_at = '2026-11-12' WHERE source_id = 'src_local' AND field_code = 'f1'",
    ).run();
    // 同一 (source_id, field_code) 主键唯一
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_field_verifications (source_id, field_code, field_label, status) VALUES ('src_local', 'f1', '重复字段', 'verified')",
        )
        .run(),
    ).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("index_value 列（TASK-04E）：CHECK 0<v≤1000 生效，up/down 重复执行幂等", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    expect(columnsOf(db, "price_observations")).toContain("index_value");
    db.prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_local', '本地来源（虚构）', 'manual')",
    ).run();
    const ins = `INSERT INTO price_observations
       (observation_id, source_id, object_type, object_id, price_type, metric_code,
        stat_date, payload_hash, index_value)
       VALUES (?, 'src_local', 'community', 'cmt_idx', 'official_index',
               'new_house_price_index', '2026-11-01', ?, ?)`;
    // CHECK 与应用层 schema/cleaning 同口径：0 < v ≤ 1000，NULL 合法
    db.prepare(ins).run("o_idx_1", "h1", 99.5);
    db.prepare(ins).run("o_idx_2", "h2", 1000); // 上界（≤）含
    db.prepare(ins).run("o_idx_null", "h3", null); // 价格观测行
    expect(() => db.prepare(ins).run("o_idx_3", "h4", 1500)).toThrow();
    expect(() => db.prepare(ins).run("o_idx_4", "h5", 0)).toThrow();
    expect(() => db.prepare(ins).run("o_idx_5", "h6", -5)).toThrow();
    // 重复 up：+migrate-idempotent 指令容错（duplicate column），既有行不丢
    expect(() => applyMigrations(db, "public", "up")).not.toThrow();
    expect(columnsOf(db, "price_observations")).toContain("index_value");
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM price_observations")
      .get() as { n: number };
    expect(n.n).toBe(3);
    // down→down→up 全程可重复（0004.down 指令容错 no such column/table）
    applyMigrations(db, "public", "down");
    expect(tablesOf(db)).toEqual([]);
    expect(() => applyMigrations(db, "public", "down")).not.toThrow();
    applyMigrations(db, "public", "up");
    expect(columnsOf(db, "price_observations")).toContain("index_value");
  });

  it("Public 库任何表都不含个人信息字段（§9.4 验收）", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    for (const table of tablesOf(db)) {
      for (const col of columnsOf(db, table)) {
        expect(
          FORBIDDEN_PUBLIC_COLUMN.test(col),
          `Public 表 ${table} 出现敏感字段 ${col}`,
        ).toBe(false);
      }
    }
    // 私有库应包含用户表，证明两库确实分离
    const priv = createDb();
    applyMigrations(priv, "private", "up");
    expect(tablesOf(priv)).toContain("users");
    expect(tablesOf(db)).not.toContain("users");
  });

  it("虚构测试数据可完成「城市→区域→小区→观测→快照」链路", () => {
    const db = createDb();
    applyMigrations(db, "public", "up");
    db.prepare(
      "INSERT INTO cities (city_code, name, province_code) VALUES ('TEST-0000', '本地测试城市（虚构）', 'TEST-PR')",
    ).run();
    db.prepare(
      "INSERT INTO regions (region_id, city_code, name, level) VALUES ('rgn_test', 'TEST-0000', '测试区（虚构）', 'district')",
    ).run();
    db.prepare(
      "INSERT INTO communities (community_id, city_code, region_id, name) VALUES ('com_test', 'TEST-0000', 'rgn_test', '测试小区（虚构）')",
    ).run();
    db.prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES ('src_test_local', '本地测试来源（虚构）', 'manual')",
    ).run();
    db.prepare(
      `INSERT INTO price_observations
       (observation_id, source_id, object_type, object_id, price_type, metric_code,
        unit_price_yuan_sqm, stat_date, payload_hash)
       VALUES ('obs_test', 'src_test_local', 'community', 'com_test', 'listing_ask',
               'median_unit_price', 20000, '2026-11-01', 'deadbeef')`,
    ).run();
    const joined = db
      .prepare(
        `SELECT o.observation_id FROM price_observations o
         JOIN communities c ON c.community_id = o.object_id
         JOIN regions r ON r.region_id = c.region_id
         WHERE r.region_id = 'rgn_test'`,
      )
      .all();
    expect(joined).toHaveLength(1);
  });
});

describe("Private D1（radar_private）", () => {
  it("up 建出全部 22 张表，且重复执行（幂等）不报错", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    expect(tablesOf(db).sort()).toEqual(PRIVATE_TABLES);
    expect(() => applyMigrations(db, "private", "up")).not.toThrow();
  });

  it("down 可回滚全部表，重复执行安全；down→up 可重建", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    applyMigrations(db, "private", "down");
    expect(tablesOf(db)).toEqual([]);
    expect(() => applyMigrations(db, "private", "down")).not.toThrow();
    applyMigrations(db, "private", "up");
    expect(tablesOf(db).sort()).toEqual(PRIVATE_TABLES);
  });

  it("索引覆盖 §9.3 私有侧核心查询", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    const idx = indexesOf(db);
    expect(idx).toContain("ix_watch_items_user_status_created"); // watch_items(user_id, status, created_at DESC)
    expect(idx).toContain("ix_watch_rules_user_enabled_type"); // watch_rules(user_id, is_enabled, rule_type)
    expect(idx).toContain("ix_alert_events_user_created"); // alert_events(user_id, created_at DESC)
    expect(idx).toContain("ix_deliveries_status_created"); // notification_deliveries(status, created_at)
    expect(idx).toContain("ix_sessions_token_expires"); // sessions(token_hash, expires_at)
    expect(idx).toContain("ix_email_otps_email_purpose_expires"); // email_otps(email_normalized, purpose, expires_at)
    expect(idx).toContain("ix_email_send_ledger_created"); // email_send_ledger(created_at, status, template) 配额求和
    expect(idx).toContain("ix_watch_item_groups_user_group"); // watch_item_groups(user_id, group_name) 分组筛选
    expect(idx).toContain("ix_push_subs_user_status"); // push_subscriptions(user_id, status) 推送订阅查询
  });

  it("push_subscriptions（TASK-05C）：endpoint 唯一、status CHECK、删用户级联", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    db.prepare(
      "INSERT INTO users (user_id, email_normalized) VALUES ('usr_push', 'push.user@example.com')",
    ).run();
    const ins =
      "INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth) VALUES (?, 'usr_push', ?, 'p256dh-x', 'auth-x')";
    db.prepare(ins).run("sub_1", "https://push.example.com/ep/secret-1");
    // endpoint UNIQUE：同一端点重复订阅被拒
    expect(() =>
      db.prepare(ins).run("sub_2", "https://push.example.com/ep/secret-1"),
    ).toThrow();
    // status CHECK：非法状态被拒
    expect(() =>
      db
        .prepare(
          "INSERT INTO push_subscriptions (subscription_id, user_id, endpoint, p256dh, auth, status) VALUES ('sub_3', 'usr_push', 'https://push.example.com/ep/secret-3', 'k', 'a', 'bogus')",
        )
        .run(),
    ).toThrow();
    // 删除用户级联清空订阅（安全存储生命周期）
    db.prepare("DELETE FROM users WHERE user_id = 'usr_push'").run();
    expect(db.prepare("SELECT * FROM push_subscriptions").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("邮件配额账本可按滚动 24 小时求和（TASK-02C 硬上限依据）", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    db.prepare(
      `INSERT INTO email_send_ledger (ledger_id, template, recipient_count, provider, status)
       VALUES ('lg_1', 'otp', 1, 'google_apps_script_mail', 'sent')`,
    ).run();
    db.prepare(
      `INSERT INTO email_send_ledger (ledger_id, template, recipient_count, provider, status)
       VALUES ('lg_2', 'otp', 1, 'google_apps_script_mail', 'failed')`,
    ).run();
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'sent' THEN recipient_count END), 0) AS total,
                COALESCE(SUM(CASE WHEN status = 'sent' AND template = 'otp' THEN recipient_count END), 0) AS otp
         FROM email_send_ledger
         WHERE created_at > datetime('now', '-24 hours')`,
      )
      .get() as { total: number; otp: number };
    expect(row.total).toBe(1);
    expect(row.otp).toBe(1);
    // 模板与状态受 CHECK 约束
    expect(() =>
      db
        .prepare(
          `INSERT INTO email_send_ledger (ledger_id, template, provider)
           VALUES ('lg_3', 'spam', 'google_apps_script_mail')`,
        )
        .run(),
    ).toThrow();
  });

  it("users / user_cities / watch_items / alert_events 唯一约束生效", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    const insUser =
      "INSERT INTO users (user_id, email_normalized) VALUES ('usr_a', 'demo.a@example.com')";
    db.prepare(insUser).run();
    expect(() => db.prepare(insUser).run()).toThrow(); // email_normalized UNIQUE
    db.prepare(
      "INSERT INTO user_cities (user_id, city_code) VALUES ('usr_a', 'TEST-0000')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO user_cities (user_id, city_code) VALUES ('usr_a', 'TEST-0000')",
        )
        .run(),
    ).toThrow(); // (user_id, city_code) UNIQUE
    const insWatch =
      "INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot) VALUES ('w_a', 'usr_a', 'region', 'rgn_x', '测试区域（虚构）')";
    db.prepare(insWatch).run();
    expect(() => db.prepare(insWatch).run()).toThrow(); // (user_id, object_type, object_id) UNIQUE
    db.prepare(
      "INSERT INTO alert_events (event_id, user_id, event_key, event_type) VALUES ('e_a', 'usr_a', 'evt-key-1', 'price_crossed')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO alert_events (event_id, user_id, event_key, event_type) VALUES ('e_b', 'usr_a', 'evt-key-1', 'price_crossed')",
        )
        .run(),
    ).toThrow(); // event_key UNIQUE
  });

  it("外键生效：孤儿行被拒，且整库无外键违规", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot) VALUES ('w_orphan', 'usr_missing', 'region', 'rgn_x', 'x')",
        )
        .run(),
    ).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("watch_item_groups：分组名长度受 CHECK，删除监控对象按 FK 级联清空分组行", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    db.prepare(
      "INSERT INTO users (user_id, email_normalized) VALUES ('usr_g', 'g@example.com')",
    ).run();
    db.prepare(
      "INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot) VALUES ('w_g', 'usr_g', 'region', 'rgn_g', 'x')",
    ).run();
    db.prepare(
      "INSERT INTO watch_item_groups (watch_id, user_id, group_name) VALUES ('w_g', 'usr_g', '核心关注')",
    ).run();
    // 分组名 1–50 字符：空串与 51 字符被 CHECK 拒绝
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_item_groups (watch_id, user_id, group_name) VALUES ('w_g', 'usr_g', '')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_item_groups (watch_id, user_id, group_name) VALUES ('w_g', 'usr_g', ?)",
        )
        .run("x".repeat(51)),
    ).toThrow();
    // 同一监控对象不能重复入组（watch_id 主键）
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_item_groups (watch_id, user_id, group_name) VALUES ('w_g', 'usr_g', '重复组')",
        )
        .run(),
    ).toThrow();
    // 删除 watch item → 分组行级联消失
    db.prepare("DELETE FROM watch_items WHERE watch_id = 'w_g'").run();
    const rows = db
      .prepare("SELECT watch_id FROM watch_item_groups WHERE watch_id = 'w_g'")
      .all();
    expect(rows).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("watch_rule_settings（TASK-03B）：日期/布尔 CHECK 生效，删规则与删对象均级联", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    db.prepare(
      "INSERT INTO users (user_id, email_normalized) VALUES ('usr_r', 'r@example.com')",
    ).run();
    db.prepare(
      "INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot) VALUES ('w_r', 'usr_r', 'community', 'com_r', 'x')",
    ).run();
    db.prepare(
      `INSERT INTO watch_rules (rule_id, watch_id, user_id, rule_type, metric_code, price_type, target_value, unit)
       VALUES ('r_r', 'w_r', 'usr_r', 'community_unit_price_lte', 'community_ask_median_unit', 'listing_ask', 20000, '元/㎡')`,
    ).run();
    // 默认三渠道全开、有效期可空
    db.prepare(
      "INSERT INTO watch_rule_settings (rule_id, user_id) VALUES ('r_r', 'usr_r')",
    ).run();
    const row = db
      .prepare(
        "SELECT valid_until, notify_email, notify_digest, notify_inapp FROM watch_rule_settings WHERE rule_id = 'r_r'",
      )
      .get() as {
      valid_until: string | null;
      notify_email: number;
      notify_digest: number;
      notify_inapp: number;
    };
    expect(row).toEqual({
      valid_until: null,
      notify_email: 1,
      notify_digest: 1,
      notify_inapp: 1,
    });
    // 有效期格式与布尔值受 CHECK 约束
    expect(() =>
      db
        .prepare(
          "UPDATE watch_rule_settings SET valid_until = '2027/01/01' WHERE rule_id = 'r_r'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "UPDATE watch_rule_settings SET notify_email = 2 WHERE rule_id = 'r_r'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO watch_rule_settings (rule_id, user_id, valid_until) VALUES ('r_missing', 'usr_r', '2027-01-01')",
        )
        .run(),
    ).toThrow(); // rule_id FK
    // 删除规则 → 设置行级联消失
    db.prepare("DELETE FROM watch_rules WHERE rule_id = 'r_r'").run();
    expect(
      db
        .prepare(
          "SELECT rule_id FROM watch_rule_settings WHERE rule_id = 'r_r'",
        )
        .all(),
    ).toEqual([]);
    // 删除监控对象 → 其下规则及设置行全部级联消失（03A 验收约定）
    db.prepare(
      `INSERT INTO watch_rules (rule_id, watch_id, user_id, rule_type, metric_code, price_type, target_value, unit)
       VALUES ('r_r2', 'w_r', 'usr_r', 'community_unit_price_lte', 'community_ask_median_unit', 'listing_ask', 19000, '元/㎡')`,
    ).run();
    db.prepare(
      "INSERT INTO watch_rule_settings (rule_id, user_id) VALUES ('r_r2', 'usr_r')",
    ).run();
    db.prepare("DELETE FROM watch_items WHERE watch_id = 'w_r'").run();
    expect(db.prepare("SELECT rule_id FROM watch_rule_settings").all()).toEqual(
      [],
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("source_approvals / ingest_*（TASK-04A）：审批记录 FK 与 CHECK、批次对象层级、nonce 主键", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    db.prepare(
      "INSERT INTO users (user_id, email_normalized) VALUES ('usr_sa', 'sa@example.com')",
    ).run();
    // 审批人必须存在（users FK）
    expect(() =>
      db
        .prepare(
          `INSERT INTO source_approvals (approval_id, source_id, approver_user_id, evidence_ref, frequency, retention_period, status_after)
           VALUES ('ap_1', 'src_local', 'usr_missing', 'contract-1', 'daily', '90d', 'approved_open')`,
        )
        .run(),
    ).toThrow();
    db.prepare(
      `INSERT INTO source_approvals (approval_id, source_id, approver_user_id, evidence_ref, frequency, retention_period, status_after, valid_until)
       VALUES ('ap_1', 'src_local', 'usr_sa', 'contract-1', 'daily', '90d', 'approved_open', '2027-06-30')`,
    ).run();
    // 审批后状态只能是两种 approved；action 只允许 approve（append-only，无其他动作）
    expect(() =>
      db
        .prepare(
          `INSERT INTO source_approvals (approval_id, source_id, approver_user_id, evidence_ref, frequency, retention_period, status_after)
           VALUES ('ap_2', 'src_local', 'usr_sa', 'c', 'daily', '90d', 'pending_review')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO source_approvals (approval_id, source_id, approver_user_id, evidence_ref, frequency, retention_period, status_after, action)
           VALUES ('ap_3', 'src_local', 'usr_sa', 'c', 'daily', '90d', 'approved_open', 'delete')`,
        )
        .run(),
    ).toThrow();
    // 批次受理记录：对象层级 CHECK
    db.prepare(
      "INSERT INTO ingest_batches (batch_id, source_id, city_code, object_level) VALUES ('b_1', 'src_local', 'TEST-0000', 'community')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO ingest_batches (batch_id, source_id, city_code, object_level) VALUES ('b_2', 'src_local', 'TEST-0000', 'galaxy')",
        )
        .run(),
    ).toThrow();
    // 防重放：同一 nonce 二次插入被主键拒绝
    db.prepare(
      "INSERT INTO ingest_nonces (nonce, expires_at) VALUES ('n_1', datetime('now', '+1 hour'))",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO ingest_nonces (nonce, expires_at) VALUES ('n_1', datetime('now', '+1 hour'))",
        )
        .run(),
    ).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("ingest_jobs / source_health_reports（TASK-04B）：任务状态与健康状态 CHECK、finish 语义可存储", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    // 任务：默认 running，非法状态被 CHECK 拒绝
    db.prepare(
      "INSERT INTO ingest_jobs (job_id, source_id, city_code) VALUES ('job_1', 'src_local', 'TEST-0000')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO ingest_jobs (job_id, source_id, city_code, status) VALUES ('job_2', 'src_local', 'TEST-0000', 'paused')",
        )
        .run(),
    ).toThrow();
    db.prepare(
      "UPDATE ingest_jobs SET status = 'failed', finished_at = datetime('now'), error_code = 'parse_error' WHERE job_id = 'job_1'",
    ).run();
    expect(() =>
      db
        .prepare("UPDATE ingest_jobs SET status = 'ok' WHERE job_id = 'job_1'")
        .run(),
    ).toThrow();
    // 健康上报：ok/degraded/down 之外被拒；latency 不能为负
    db.prepare(
      "INSERT INTO source_health_reports (report_id, source_id, status, latency_ms) VALUES ('hr_1', 'src_local', 'degraded', 820)",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_health_reports (report_id, source_id, status) VALUES ('hr_2', 'src_local', 'healthy')",
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          "INSERT INTO source_health_reports (report_id, source_id, status, latency_ms) VALUES ('hr_3', 'src_local', 'ok', -1)",
        )
        .run(),
    ).toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("所有 user-owned 表都带 user_id（email_otps/email_send_ledger/audit_logs 为设计例外）", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    const exceptions = new Set([
      "email_otps",
      "email_send_ledger",
      "audit_logs",
      "users",
      // TASK-04A：审批记录归属审批人（approver_user_id）、批次与防重放台账为系统级数据
      "source_approvals",
      "ingest_batches",
      "ingest_nonces",
      // TASK-04B：任务与来源健康为系统级采集数据
      "ingest_jobs",
      "source_health_reports",
    ]);
    for (const table of tablesOf(db)) {
      if (exceptions.has(table)) continue;
      expect(columnsOf(db, table), `${table} 缺少 user_id`).toContain(
        "user_id",
      );
    }
  });

  it("虚构测试数据可完成「用户→城市→监控→规则→告警→投递」链路", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    db.prepare(
      "INSERT INTO users (user_id, email_normalized, email_verified_at) VALUES ('usr_demo', 'demo.user@example.com', datetime('now'))",
    ).run();
    db.prepare(
      "INSERT INTO user_cities (user_id, city_code, is_default) VALUES ('usr_demo', 'TEST-0000', 1)",
    ).run();
    db.prepare(
      "INSERT INTO watch_items (watch_id, user_id, object_type, object_id, display_name_snapshot) VALUES ('w_demo', 'usr_demo', 'region', 'rgn_x', '测试区域（虚构）')",
    ).run();
    db.prepare(
      `INSERT INTO watch_rules (rule_id, watch_id, user_id, rule_type, metric_code, target_value, unit)
       VALUES ('r_demo', 'w_demo', 'usr_demo', 'price_below', 'median_unit_price', 20000, 'yuan_sqm')`,
    ).run();
    db.prepare(
      `INSERT INTO alert_events (event_id, user_id, rule_id, watch_id, event_key, event_type, old_value, new_value, target_value)
       VALUES ('e_demo', 'usr_demo', 'r_demo', 'w_demo', 'price_crossed', 'r_demo|2026-11-01|below', 21000, 19500, 20000)`,
    ).run();
    db.prepare(
      `INSERT INTO notification_deliveries (delivery_id, event_id, user_id, channel, provider, status)
       VALUES ('d_demo', 'e_demo', 'usr_demo', 'email', 'apps_script', 'pending')`,
    ).run();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const rows = db
      .prepare(
        `SELECT d.delivery_id FROM notification_deliveries d
         JOIN alert_events e ON e.event_id = d.event_id
         JOIN watch_rules r ON r.rule_id = e.rule_id
         JOIN watch_items w ON w.watch_id = r.watch_id
         WHERE w.user_id = 'usr_demo'`,
      )
      .all();
    expect(rows).toHaveLength(1);
  });

  it("OTP 只存哈希列且可按（邮箱, 目的, 到期）索引查询", () => {
    const db = createDb();
    applyMigrations(db, "private", "up");
    const cols = columnsOf(db, "email_otps");
    expect(cols).toContain("code_hash");
    expect(cols).not.toContain("code");
    db.prepare(
      `INSERT INTO email_otps (otp_id, email_normalized, code_hash, expires_at)
       VALUES ('otp_demo', 'demo.user@example.com', 'sha256:fakehash', datetime('now', '+10 minutes'))`,
    ).run();
    const plan = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name = 'ix_email_otps_email_purpose_expires'",
      )
      .all();
    expect(plan).toHaveLength(1);
  });
});
