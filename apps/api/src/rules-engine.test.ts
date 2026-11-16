// TASK-05A：规则引擎与系统事件（并入 03C 核心）
// 覆盖：五场景状态机 / 质量门控 / 复跑幂等 / price_drop 窗口跌幅 /
// 更新延迟与数据异常归属 / 投递占位与故障隔离（邮件 provider 不可用事件保留）。
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, createEvent, shanghaiDate } from "./events";
import { evaluateRulesForObjects, evaluateSystemEvents } from "./rules-engine";
import { createTestEnv, seedUser, type TestContext } from "./test-utils/setup";

let ctx: TestContext;
const USER_A = "usr_05a_a";
const USER_B = "usr_05a_b";
const CMT = "cmt_05a_1";
const CITY = "T5A-0001";
const SRC = "src_05a";
const METRIC = "community_ask_median_unit";

function base() {
  return { object_type: "community", object_id: CMT };
}

function events(): Array<Record<string, unknown>> {
  return ctx.priv
    .prepare("SELECT * FROM alert_events ORDER BY rowid")
    .all() as unknown as Array<Record<string, unknown>>;
}

function deliveries(channel?: string): Array<Record<string, unknown>> {
  const sql = channel
    ? "SELECT * FROM notification_deliveries WHERE channel = ? ORDER BY rowid"
    : "SELECT * FROM notification_deliveries ORDER BY rowid";
  const stmt = ctx.priv.prepare(sql);
  return (channel ? stmt.all(channel) : stmt.all()) as unknown as Array<
    Record<string, unknown>
  >;
}

function ruleState(ruleId: string): { armed_state: string } {
  return ctx.priv
    .prepare("SELECT armed_state FROM watch_rules WHERE rule_id = ?")
    .get(ruleId) as unknown as { armed_state: string };
}

async function seedWatch(watchId: string, userId: string, objectId = CMT) {
  await ctx.priv
    .prepare(
      `INSERT INTO watch_items
         (watch_id, user_id, object_type, object_id, display_name_snapshot)
       VALUES (?, ?, 'community', ?, 'TEST-05A小区（虚构）')`,
    )
    .run(watchId, userId, objectId);
}

interface RuleOpts {
  ruleType?: string;
  target?: number | null;
  windowDays?: number | null;
  threshold?: number | null;
  hyst?: number;
  armed?: string;
}

async function seedRule(
  ruleId: string,
  watchId: string,
  userId: string,
  opts: RuleOpts = {},
) {
  await ctx.priv
    .prepare(
      `INSERT INTO watch_rules
         (rule_id, watch_id, user_id, rule_type, metric_code, price_type,
          target_value, unit, window_days, threshold_pct, hysteresis_pct,
          is_enabled, armed_state, version)
       VALUES (?, ?, ?, ?, ?, 'listing_ask', ?, '元/㎡', ?, ?, ?, 1, ?, 2)`,
    )
    .run(
      ruleId,
      watchId,
      userId,
      opts.ruleType ?? "community_unit_price_lte",
      METRIC,
      opts.target === undefined ? 30000 : opts.target,
      opts.windowDays ?? null,
      opts.threshold ?? null,
      opts.hyst ?? 2,
      opts.armed ?? "armed",
    );
}

function seedSnapshot(
  statDate: string,
  median: number,
  opts: {
    quality?: string;
    priceType?: string;
    metric?: string;
    objectId?: string;
  } = {},
) {
  const objectId = opts.objectId ?? CMT;
  const priceType = opts.priceType ?? "listing_ask";
  const metric = opts.metric ?? METRIC;
  ctx.pub
    .prepare(
      `INSERT INTO price_snapshots
         (snapshot_id, object_type, object_id, price_type, metric_code,
          median, sample_count, stat_date, source_id, quality_status)
       VALUES (?, 'community', ?, ?, ?, ?, 6, ?, ?, ?)`,
    )
    .run(
      `snap_${objectId}_${priceType}_${metric}_${statDate}`,
      objectId,
      priceType,
      metric,
      median,
      statDate,
      SRC,
      opts.quality ?? "valid",
    );
}

beforeEach(async () => {
  ctx = createTestEnv();
  await seedUser(ctx.priv, USER_A, "u05a-a@example.test", "tok-05a-a");
  await seedUser(ctx.priv, USER_B, "u05a-b@example.test", "tok-05a-b");
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, 'TEST-05A来源（虚构）', 'open_data')",
    )
    .run(SRC);
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status) VALUES (?, 'TEST-05A市', 'TP', 'active')",
    )
    .run(CITY);
  ctx.pub
    .prepare(
      "INSERT INTO communities (community_id, city_code, name, status) VALUES (?, ?, 'TEST-05A小区（虚构）', 'active')",
    )
    .run(CMT, CITY);
});

describe("03C 五场景：目标价状态机", () => {
  it("场景1：目标价上方不触发，保持 armed", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A);
    seedSnapshot("2026-11-10", 32000);
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats).toEqual({
      rules_evaluated: 1,
      events_created: 0,
      rearmed: 0,
    });
    expect(events()).toHaveLength(0);
    expect(ruleState("r1").armed_state).toBe("armed");
  });

  it("场景2：首次跌破生成事件（前后值/价差/版本/投递全落），armed → triggered", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A); // version=2
    seedSnapshot("2026-11-10", 32000);
    seedSnapshot("2026-11-11", 29500);
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.events_created).toBe(1);
    const ev = events();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event_type).toBe("target_price_reached");
    expect(ev[0]!.old_value).toBe(32000);
    expect(ev[0]!.new_value).toBe(29500);
    expect(ev[0]!.target_value).toBe(30000);
    expect(ev[0]!.difference_pct).toBeCloseTo(-7.81, 2);
    expect(ev[0]!.status).toBe("unread");
    expect(String(ev[0]!.event_key)).toContain("|snap_cmt_05a_1_");
    const evidence = JSON.parse(String(ev[0]!.evidence_json)) as Record<
      string,
      unknown
    >;
    expect(evidence.rule_version).toBe(2); // 规则版本留存（§4.6-6）
    expect(evidence.target_value).toBe(30000);
    expect(evidence.stat_date).toBe("2026-11-11");
    expect(evidence.quality_status).toBe("valid");
    expect(String(evidence.explanation)).toContain("目标价 30000");
    expect(Array.isArray(evidence.evidence_lines)).toBe(true);
    expect(ruleState("r1").armed_state).toBe("triggered");
    // 投递落行：in_app 必达；网关未配置 → 如实 provider_error/provider_unavailable（不谎称已发送）
    expect(deliveries("in_app")).toHaveLength(1);
    expect(deliveries("in_app")[0]!.status).toBe("sent");
    const email = deliveries("email");
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe("provider_error");
    expect(email[0]!.last_error_code).toBe("provider_unavailable");
  });

  it("场景3：持续低于不重复（triggered 抑制）", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A);
    seedSnapshot("2026-11-10", 32000);
    seedSnapshot("2026-11-11", 29500);
    await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    seedSnapshot("2026-11-12", 29000);
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-14T00:00:00Z"),
    );
    expect(stats.events_created).toBe(0);
    expect(events()).toHaveLength(1);
    expect(ruleState("r1").armed_state).toBe("triggered");
  });

  it("场景4：回升超过缓冲 re-arm，不产生事件", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A, { hyst: 2 }); // 缓冲 2% → re-arm 线 30600
    seedSnapshot("2026-11-10", 32000);
    seedSnapshot("2026-11-11", 29500);
    await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-12T00:00:00Z"),
    );
    seedSnapshot("2026-11-12", 31000);
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.rearmed).toBe(1);
    expect(stats.events_created).toBe(0);
    expect(events()).toHaveLength(1);
    expect(ruleState("r1").armed_state).toBe("armed");
  });

  it("场景5：再次跌破生成第二条事件（新 event_key）", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A, { hyst: 2 });
    seedSnapshot("2026-11-08", 32000);
    seedSnapshot("2026-11-09", 29500);
    await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-10T00:00:00Z"),
    );
    seedSnapshot("2026-11-10", 31000);
    await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-11T00:00:00Z"),
    );
    seedSnapshot("2026-11-11", 29800);
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-12T00:00:00Z"),
    );
    expect(stats.events_created).toBe(1);
    const ev = events();
    expect(ev).toHaveLength(2);
    expect(ev[0]!.event_key).not.toBe(ev[1]!.event_key);
    expect(ev[1]!.new_value).toBe(29800);
    expect(deliveries("in_app")).toHaveLength(2);
  });
});

describe("幂等与质量门控", () => {
  it("复跑幂等：event_key 冲突零新增且不重复投递", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A);
    seedSnapshot("2026-11-11", 29500);
    const now = new Date("2026-11-13T00:00:00Z");
    await evaluateRulesForObjects(ctx.env, [base()], now);
    expect(events()).toHaveLength(1);
    // 模拟状态被重置后的复跑：同一快照键 → UNIQUE 拦截，零新增、零重复投递
    ctx.priv
      .prepare(
        "UPDATE watch_rules SET armed_state = 'armed' WHERE rule_id = 'r1'",
      )
      .run();
    const stats = await evaluateRulesForObjects(ctx.env, [base()], now);
    expect(stats.events_created).toBe(0);
    expect(events()).toHaveLength(1);
    expect(deliveries("in_app")).toHaveLength(1);
    expect(deliveries("email")).toHaveLength(1);
  });

  it("质量门控：stale 不触发，low_sample 可触发并在证据标注质量", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A);
    seedSnapshot("2026-11-09", 29000, { quality: "stale" });
    let stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.events_created).toBe(0);
    expect(events()).toHaveLength(0);
    expect(ruleState("r1").armed_state).toBe("armed");

    seedSnapshot("2026-11-11", 29000, { quality: "low_sample" });
    stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.events_created).toBe(1);
    const evidence = JSON.parse(String(events()[0]!.evidence_json)) as Record<
      string,
      unknown
    >;
    expect(evidence.quality_status).toBe("low_sample");
    expect(String((evidence.evidence_lines as string[]).join("\n"))).toContain(
      "样本不足",
    );
  });

  it("低于目标价规则类型之外（below_comparable 等）本期跳过不评估", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A, {
      ruleType: "below_comparable_median_pct",
      target: null,
      threshold: 10,
      windowDays: 180,
    });
    seedSnapshot("2026-11-11", 29000);
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.rules_evaluated).toBe(0);
    expect(events()).toHaveLength(0);
  });
});

describe("price_drop 窗口跌幅", () => {
  it("达阈值触发 → 持续抑制 → 回撤 re-arm → 再达阈值新事件", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A, {
      ruleType: "price_drop_pct",
      target: null,
      windowDays: 30,
      threshold: 5,
      hyst: 2,
    });
    seedSnapshot("2026-10-20", 10000);
    seedSnapshot("2026-11-10", 9400); // 跌 6% ≥ 5%
    let stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.events_created).toBe(1);
    const ev1 = events();
    expect(ev1[0]!.event_type).toBe("price_drop");
    expect(ev1[0]!.old_value).toBe(10000);
    expect(ev1[0]!.new_value).toBe(9400);
    expect(ev1[0]!.difference_pct).toBeCloseTo(-6, 2);
    const e1 = JSON.parse(String(ev1[0]!.evidence_json)) as Record<
      string,
      unknown
    >;
    expect(e1.drop_pct).toBe(6);
    expect(e1.baseline_stat_date).toBe("2026-10-20");
    expect(e1.threshold_pct).toBe(5);
    expect(ruleState("r1").armed_state).toBe("triggered");

    seedSnapshot("2026-11-11", 9450); // 跌 5.5% 仍 ≥5% → 抑制
    stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.events_created).toBe(0);
    expect(events()).toHaveLength(1);

    seedSnapshot("2026-11-12", 9900); // 跌 1% < 5−2 → re-arm
    stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.rearmed).toBe(1);
    expect(ruleState("r1").armed_state).toBe("armed");

    seedSnapshot("2026-11-13", 9450); // 再次 5.5% → 第二条
    stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-14T00:00:00Z"),
    );
    expect(stats.events_created).toBe(1);
    expect(events()).toHaveLength(2);
  });

  it("窗口内无更早基线不触发", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A, {
      ruleType: "price_drop_pct",
      target: null,
      windowDays: 30,
      threshold: 5,
      hyst: 2,
    });
    seedSnapshot("2026-11-11", 9400); // 仅当前期
    const stats = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(stats.events_created).toBe(0);
    expect(events()).toHaveLength(0);
  });
});

describe("系统事件：更新延迟 / 数据异常", () => {
  it("更新延迟：超 SLA 生成、证据含 SLA 与滞后天数、同日复跑幂等", async () => {
    const today = shanghaiDate(new Date());
    await seedWatch("w1", USER_A);
    seedSnapshot(addDays(today, -30), 30000); // 默认 SLA 10 天 → 滞后 30 天
    let stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.delayed).toBe(1);
    const ev = events();
    expect(ev).toHaveLength(1);
    expect(ev[0]!.event_type).toBe("update_delayed");
    expect(ev[0]!.rule_id).toBeNull();
    expect(ev[0]!.watch_id).toBe("w1");
    expect(String(ev[0]!.event_key)).toContain(`sys|delayed|w1|${today}`);
    const e = JSON.parse(String(ev[0]!.evidence_json)) as Record<
      string,
      unknown
    >;
    expect(e.sla_days).toBe(10);
    expect(e.delay_days).toBe(30);
    expect(String(e.explanation)).toContain("滞后 30 天");

    stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.delayed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(events()).toHaveLength(1);
  });

  it("更新延迟：SLA 内不生成；零快照（uncovered）不生成", async () => {
    const today = shanghaiDate(new Date());
    await seedWatch("w1", USER_A);
    seedSnapshot(addDays(today, -5), 30000); // SLA 10 内
    await seedWatch("w2", USER_A, "cmt_05a_none"); // 零快照对象
    const stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.delayed).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(events()).toHaveLength(0);
  });

  it("更新延迟：official_index SLA 45 天", async () => {
    const today = shanghaiDate(new Date());
    await seedWatch("w1", USER_A);
    seedSnapshot(addDays(today, -30), 99, {
      priceType: "official_index",
      metric: "official_index",
    });
    let stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.delayed).toBe(0); // 30 < 45 月度 SLA 内

    await seedWatch("w2", USER_A, "cmt_05a_idx");
    seedSnapshot(addDays(today, -50), 98, {
      priceType: "official_index",
      metric: "official_index",
      objectId: "cmt_05a_idx",
    });
    stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.delayed).toBe(1);
    const ev = events();
    const e = JSON.parse(String(ev[0]!.evidence_json)) as Record<
      string,
      unknown
    >;
    expect(e.sla_days).toBe(45);
  });

  it("数据异常：失败任务按城市归属到每个 owner，重复评估幂等", async () => {
    await seedWatch("w1", USER_A);
    await seedWatch("w2", USER_B); // 同对象双 owner
    ctx.priv
      .prepare(
        `INSERT INTO ingest_jobs (job_id, source_id, city_code, status, error_code)
         VALUES ('job_05a_f1', ?, ?, 'failed', 'upstream_500')`,
      )
      .run(SRC, CITY);
    let stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.anomaly).toBe(2); // 两用户各一条
    const ev = events();
    expect(ev).toHaveLength(2);
    expect(ev.map((e) => e.user_id).sort()).toEqual([USER_A, USER_B].sort());
    for (const row of ev) {
      expect(row.event_type).toBe("data_anomaly");
      const e = JSON.parse(String(row.evidence_json)) as Record<
        string,
        unknown
      >;
      expect(e.trigger).toBe("job_failed");
      expect(e.job_id).toBe("job_05a_f1");
      expect(e.source_name).toBe("TEST-05A来源（虚构）");
      expect(e.city_code).toBe(CITY);
    }
    stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.anomaly).toBe(0);
    expect(events()).toHaveLength(2);
  });

  it("数据异常：失败任务城市不匹配不归属", async () => {
    await seedWatch("w1", USER_A);
    ctx.priv
      .prepare(
        `INSERT INTO ingest_jobs (job_id, source_id, city_code, status, error_code)
         VALUES ('job_05a_other', ?, 'OTHER-CITY', 'failed', 'timeout')`,
      )
      .run(SRC);
    const stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.anomaly).toBe(0);
    expect(events()).toHaveLength(0);
  });

  it("数据异常：健康 down 需城市覆盖，覆盖到位后生成", async () => {
    await seedWatch("w1", USER_A);
    ctx.priv
      .prepare(
        `INSERT INTO source_health_reports (report_id, source_id, status, latency_ms, detail)
         VALUES ('rep_05a_down', ?, 'down', 3000, '来源不可用')`,
      )
      .run(SRC);
    let stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.anomaly).toBe(0); // 尚无覆盖

    ctx.pub
      .prepare(
        `INSERT INTO source_city_coverage
           (source_id, city_code, object_level, authorization_status)
         VALUES (?, ?, 'community', 'approved_open')`,
      )
      .run(SRC, CITY);
    stats = await evaluateSystemEvents(ctx.env, new Date());
    expect(stats.anomaly).toBe(1);
    const e = JSON.parse(String(events()[0]!.evidence_json)) as Record<
      string,
      unknown
    >;
    expect(e.trigger).toBe("source_down");
    expect(e.report_id).toBe("rep_05a_down");
  });
});

describe("投递占位与故障隔离（验收：邮件 provider 不可用时站内事件保留）", () => {
  it("注入抛错 provider：事件与 in_app 行保留，email 恒非 sent 且不落错误消息", async () => {
    await seedWatch("w1", USER_A);
    const res = await createEvent(
      ctx.env,
      {
        userId: USER_A,
        ruleId: null,
        watchId: "w1",
        eventType: "update_delayed",
        eventKey: "fault|w1|2026-11-13",
        evidence: { explanation: "注入故障的事件" },
      },
      {
        sendEmail: async () => {
          throw new Error("provider boom recipient@example.test");
        },
      },
    );
    expect(res.created).toBe(true);
    expect(events()).toHaveLength(1); // 事件保留
    expect(deliveries("in_app")).toHaveLength(1);
    expect(deliveries("in_app")[0]!.status).toBe("sent");
    const email = deliveries("email");
    expect(email).toHaveLength(1);
    expect(email[0]!.status).toBe("provider_error");
    // 05B：失败立即重试 1 次 → 共 2 次尝试后放弃（R3.3）
    expect(email[0]!.attempt_count).toBe(2);
    // 错误消息（可能含收件人）不入库，只落错误码
    expect(String(email[0]!.last_error_code)).toBe("provider_error");
    expect(JSON.stringify(email)).not.toContain("recipient@example.test");
  });

  it("email_enabled=0 用户只写 in_app 投递", async () => {
    ctx.priv
      .prepare(
        "INSERT INTO notification_preferences (user_id, email_enabled) VALUES (?, 0)",
      )
      .run(USER_A);
    await seedWatch("w1", USER_A);
    const res = await createEvent(ctx.env, {
      userId: USER_A,
      watchId: "w1",
      eventType: "update_delayed",
      eventKey: "pref|w1|2026-11-13",
      evidence: {},
    });
    expect(res.created).toBe(true);
    expect(deliveries("in_app")).toHaveLength(1);
    expect(deliveries("email")).toHaveLength(0);
  });
});

// ---------------- TASK-06B 拍板2：冻结用户停新事件，数据保留 ----------------

describe("TASK-06B 冻结政策：停新事件（解冻即恢复）", () => {
  it("冻结用户规则不评估不产生事件；解冻后同数据恢复触发", async () => {
    await seedWatch("w1", USER_A);
    await seedRule("r1", "w1", USER_A);
    seedSnapshot("2026-11-10", 32000);
    seedSnapshot("2026-11-11", 29500); // 首次跌破目标价 30000

    ctx.priv
      .prepare("UPDATE users SET status = 'frozen' WHERE user_id = ?")
      .run(USER_A);
    const frozen = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(frozen).toEqual({
      rules_evaluated: 0,
      events_created: 0,
      rearmed: 0,
    });
    expect(events()).toHaveLength(0);
    expect(ruleState("r1").armed_state).toBe("armed");

    ctx.priv
      .prepare("UPDATE users SET status = 'active' WHERE user_id = ?")
      .run(USER_A);
    const active = await evaluateRulesForObjects(
      ctx.env,
      [base()],
      new Date("2026-11-13T00:00:00Z"),
    );
    expect(active.events_created).toBe(1);
    expect(events()).toHaveLength(1);
  });
});
