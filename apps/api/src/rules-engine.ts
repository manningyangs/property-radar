// TASK-05A（并入 03C 核心）：价格规则引擎与系统事件评估（PRD §4.6 目标价规则 /
// §4.7 数据质量状态 / §2.8 事件中心 / §6.6 定时任务）。
// 服务端唯一实现点：规则状态机、质量门控、幂等事件、系统事件（延迟/异常）判定。
import type { Env } from "./env";
import { addDays, createEvent, daysBetween, shanghaiDate } from "./events";

// ---------------- 口径常量（唯一真源） ----------------

/** §4.7 质量门控：仅 valid/low_sample 触发；stale/outlier/rejected 不触发（uncovered=无快照天然不触发） */
export const TRIGGERABLE_QUALITY = new Set(["valid", "low_sample"]);
/** 目标价类规则（≤ 目标即满足） */
export const TARGET_RULE_TYPES = new Set([
  "community_unit_price_lte",
  "listing_unit_price_lte",
  "listing_total_price_lte",
]);
/** 更新延迟 SLA（天）：按快照 price_type；月度官方指数 45 天，其余默认 10 天 */
export const DELAY_SLA_DAYS: Record<string, number> = { official_index: 45 };
export const DELAY_SLA_DEFAULT_DAYS = 10;
/** 数据异常判定窗口（小时）：失败任务 / 健康 down 上报 */
export const ANOMALY_WINDOW_HOURS = 24;

const METRIC_LABELS: Record<string, string> = {
  community_ask_median_unit: "挂牌中位单价",
  listing_ask_unit: "挂牌单价",
  listing_median_total_price: "挂牌中位总价",
  closed_unit: "成交单价",
  closed_total: "成交总价",
  official_index: "官方价格指数",
};

const QUALITY_LABELS: Record<string, string> = {
  valid: "可用",
  low_sample: "样本不足",
  stale: "已过期",
  outlier: "离群",
  rejected: "已拒绝",
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------- 行类型 ----------------

interface RuleRow {
  rule_id: string;
  watch_id: string;
  user_id: string;
  rule_type: string;
  metric_code: string;
  price_type: string | null;
  target_value: number | null;
  unit: string | null;
  window_days: number | null;
  threshold_pct: number | null;
  hysteresis_pct: number | null;
  armed_state: string;
  version: number;
  object_type: string;
  object_id: string;
  display_name_snapshot: string;
}

interface SnapshotRow {
  snapshot_id: string;
  median: number | null;
  sample_count: number;
  stat_date: string;
  source_id: string | null;
  quality_status: string;
}

interface WatchRow {
  watch_id: string;
  user_id: string;
  object_type: string;
  object_id: string;
  display_name_snapshot: string;
}

export interface RuleEvaluation {
  rules_evaluated: number;
  events_created: number;
  rearmed: number;
}

export interface SystemEvaluation {
  delayed: number;
  anomaly: number;
  skipped: number;
}

// ---------------- 快照查询（Public） ----------------

async function latestSnapshot(
  env: Env,
  rule: RuleRow,
): Promise<SnapshotRow | null> {
  return await env.DB_PUBLIC.prepare(
    `SELECT snapshot_id, median, sample_count, stat_date, source_id, quality_status
       FROM price_snapshots
      WHERE object_type = ? AND object_id = ? AND metric_code = ? AND price_type = ?
      ORDER BY stat_date DESC
      LIMIT 1`,
  )
    .bind(rule.object_type, rule.object_id, rule.metric_code, rule.price_type)
    .first<SnapshotRow>();
}

/** 触发前值：次新快照（与当前同键） */
async function previousSnapshot(
  env: Env,
  rule: RuleRow,
): Promise<{ median: number | null; stat_date: string } | null> {
  return await env.DB_PUBLIC.prepare(
    `SELECT median, stat_date
       FROM price_snapshots
      WHERE object_type = ? AND object_id = ? AND metric_code = ? AND price_type = ?
      ORDER BY stat_date DESC
      LIMIT 1 OFFSET 1`,
  )
    .bind(rule.object_type, rule.object_id, rule.metric_code, rule.price_type)
    .first<{ median: number | null; stat_date: string }>();
}

async function setArmedState(
  env: Env,
  ruleId: string,
  state: "armed" | "triggered",
): Promise<void> {
  await env.DB_PRIVATE.prepare(
    "UPDATE watch_rules SET armed_state = ?, updated_at = datetime('now') WHERE rule_id = ?",
  )
    .bind(state, ruleId)
    .run();
}

// ---------------- 目标价类规则 ----------------

async function evalTargetRule(
  env: Env,
  rule: RuleRow,
  current: SnapshotRow,
  stats: RuleEvaluation,
): Promise<void> {
  const value = current.median;
  if (value === null || rule.target_value === null) return;
  const target = rule.target_value;
  const hyst = rule.hysteresis_pct ?? 0;
  const met = value <= target;

  if (rule.armed_state === "armed" && met) {
    const prev = await previousSnapshot(env, rule);
    const oldValue = prev?.median ?? null;
    const changePct =
      oldValue !== null && oldValue !== 0
        ? round2(((value - oldValue) / oldValue) * 100)
        : null;
    const gapPct =
      target !== 0 ? round2(((value - target) / target) * 100) : null;
    const unit = rule.unit ?? "元/㎡";
    const label = METRIC_LABELS[rule.metric_code] ?? rule.metric_code;
    const res = await createEvent(env, {
      userId: rule.user_id,
      ruleId: rule.rule_id,
      watchId: rule.watch_id,
      snapshotId: current.snapshot_id,
      eventType: "target_price_reached",
      oldValue,
      newValue: value,
      targetValue: target,
      differencePct: changePct,
      eventKey: `${rule.rule_id}|${rule.object_type}:${rule.object_id}|${rule.metric_code}|${current.snapshot_id}`,
      evidence: {
        rule_version: rule.version,
        target_value: target,
        unit,
        object_type: rule.object_type,
        object_id: rule.object_id,
        display_name: rule.display_name_snapshot,
        metric_code: rule.metric_code,
        metric_label: label,
        price_type: rule.price_type,
        stat_date: current.stat_date,
        source_id: current.source_id,
        sample_count: current.sample_count,
        quality_status: current.quality_status,
        quality_label:
          QUALITY_LABELS[current.quality_status] ?? current.quality_status,
        previous_stat_date: prev?.stat_date ?? null,
        previous_value: oldValue,
        target_gap_pct: gapPct,
        explanation: `「${rule.display_name_snapshot}」${label}为 ${value} ${unit}，已达到目标价 ${target} ${unit}（差 ${gapPct ?? "—"}%，触发前值 ${oldValue ?? "—"}）。`,
        evidence_lines: [
          `统计日期 ${current.stat_date}`,
          `来源 ${current.source_id ?? "未知"}`,
          `样本量 ${current.sample_count}（质量 ${QUALITY_LABELS[current.quality_status] ?? current.quality_status}）`,
          `规则版本 v${rule.version} · 目标 ${target} ${unit}`,
          `触发前值 ${oldValue ?? "—"}${oldValue !== null ? `（${prev?.stat_date ?? ""}）` : ""}`,
        ],
      },
    });
    if (res.created) stats.events_created += 1;
    await setArmedState(env, rule.rule_id, "triggered");
    return;
  }

  if (rule.armed_state === "triggered") {
    // 回到目标上方并超过缓冲幅度（hysteresis_pct NULL 视为 0）→ 重新布防，不产生事件（§4.6-5）
    if (value > target * (1 + hyst / 100)) {
      await setArmedState(env, rule.rule_id, "armed");
      stats.rearmed += 1;
    }
  }
}

// ---------------- 窗口降幅规则 ----------------

async function evalDropRule(
  env: Env,
  rule: RuleRow,
  current: SnapshotRow,
  now: Date,
  stats: RuleEvaluation,
): Promise<void> {
  const value = current.median;
  if (value === null) return;
  if (rule.window_days === null || rule.threshold_pct === null) return;
  const windowStart = addDays(shanghaiDate(now), -rule.window_days);
  const baseline = await env.DB_PUBLIC.prepare(
    `SELECT median, stat_date
       FROM price_snapshots
      WHERE object_type = ? AND object_id = ? AND metric_code = ? AND price_type = ?
        AND stat_date >= ? AND median IS NOT NULL
        AND quality_status IN ('valid', 'low_sample')
      ORDER BY stat_date ASC
      LIMIT 1`,
  )
    .bind(
      rule.object_type,
      rule.object_id,
      rule.metric_code,
      rule.price_type,
      windowStart,
    )
    .first<{ median: number; stat_date: string }>();
  // 窗口内无可比基线或基线就是当前期（无更早快照）→ 不触发
  if (!baseline || baseline.stat_date >= current.stat_date) return;
  if (baseline.median <= 0) return;
  const dropPct = round2(((baseline.median - value) / baseline.median) * 100);
  const threshold = rule.threshold_pct;
  const hyst = rule.hysteresis_pct ?? 0;
  const met = dropPct >= threshold;

  if (rule.armed_state === "armed" && met) {
    const unit = rule.unit ?? "元/㎡";
    const label = METRIC_LABELS[rule.metric_code] ?? rule.metric_code;
    const changePct = round2(
      ((value - baseline.median) / baseline.median) * 100,
    );
    const res = await createEvent(env, {
      userId: rule.user_id,
      ruleId: rule.rule_id,
      watchId: rule.watch_id,
      snapshotId: current.snapshot_id,
      eventType: "price_drop",
      oldValue: baseline.median,
      newValue: value,
      targetValue: null,
      differencePct: changePct,
      eventKey: `${rule.rule_id}|${rule.object_type}:${rule.object_id}|${rule.metric_code}|${current.snapshot_id}`,
      evidence: {
        rule_version: rule.version,
        threshold_pct: threshold,
        window_days: rule.window_days,
        unit,
        object_type: rule.object_type,
        object_id: rule.object_id,
        display_name: rule.display_name_snapshot,
        metric_code: rule.metric_code,
        metric_label: label,
        price_type: rule.price_type,
        stat_date: current.stat_date,
        source_id: current.source_id,
        sample_count: current.sample_count,
        quality_status: current.quality_status,
        quality_label:
          QUALITY_LABELS[current.quality_status] ?? current.quality_status,
        baseline_stat_date: baseline.stat_date,
        baseline_value: baseline.median,
        drop_pct: dropPct,
        explanation: `「${rule.display_name_snapshot}」${label}在 ${rule.window_days} 天内由 ${baseline.median} 降至 ${value} ${unit}（跌幅 ${dropPct}%，阈值 ${threshold}%）。`,
        evidence_lines: [
          `统计日期 ${current.stat_date}`,
          `窗口起点 ${baseline.stat_date}（${baseline.median} ${unit}）`,
          `跌幅 ${dropPct}% ≥ 阈值 ${threshold}%（窗口 ${rule.window_days} 天）`,
          `来源 ${current.source_id ?? "未知"}`,
          `样本量 ${current.sample_count}（质量 ${QUALITY_LABELS[current.quality_status] ?? current.quality_status}）`,
          `规则版本 v${rule.version}`,
        ],
      },
    });
    if (res.created) stats.events_created += 1;
    await setArmedState(env, rule.rule_id, "triggered");
    return;
  }

  if (rule.armed_state === "triggered") {
    // 跌幅回落到 阈值−缓冲 以下 → 重新布防（不产生事件）
    if (dropPct < threshold - hyst) {
      await setArmedState(env, rule.rule_id, "armed");
      stats.rearmed += 1;
    }
  }
}

// ---------------- 规则评估入口（批次入库后调用） ----------------

/**
 * 评估受影响对象上的启用规则（armed/triggered 状态机 + 质量门控 + event_key 幂等）。
 * 仅 valid/low_sample 的最新快照参与；below_comparable_median_pct 等其余类型
 * 本期不评估（可比组数据未接入，05A 范围外，跳过不报错）。
 */
export async function evaluateRulesForObjects(
  env: Env,
  objects: ReadonlyArray<{ object_type: string; object_id: string }>,
  now: Date,
): Promise<RuleEvaluation> {
  const stats: RuleEvaluation = {
    rules_evaluated: 0,
    events_created: 0,
    rearmed: 0,
  };
  if (objects.length === 0) return stats;
  const wanted = new Set(objects.map((o) => `${o.object_type}|${o.object_id}`));
  const rules = await env.DB_PRIVATE.prepare(
    `SELECT r.rule_id, r.watch_id, r.user_id, r.rule_type, r.metric_code, r.price_type,
            r.target_value, r.unit, r.window_days, r.threshold_pct, r.hysteresis_pct,
            r.armed_state, r.version,
            w.object_type, w.object_id, w.display_name_snapshot
       FROM watch_rules r
       JOIN watch_items w ON w.watch_id = r.watch_id
       JOIN users u ON u.user_id = r.user_id
      WHERE r.is_enabled = 1 AND w.status = 'active'
        AND u.status = 'active' AND u.deleted_at IS NULL`,
    // TASK-06B 拍板2：冻结/注销用户不产生新事件（既有数据保留，解冻即恢复）
  ).all<RuleRow>();

  for (const rule of rules.results) {
    if (!wanted.has(`${rule.object_type}|${rule.object_id}`)) continue;
    if (
      !TARGET_RULE_TYPES.has(rule.rule_type) &&
      rule.rule_type !== "price_drop_pct"
    ) {
      continue; // 其余规则类型本期不评估（见上）
    }
    if (!rule.price_type) continue;
    stats.rules_evaluated += 1;
    const current = await latestSnapshot(env, rule);
    if (!current) continue; // uncovered：无快照不触发
    if (!TRIGGERABLE_QUALITY.has(current.quality_status)) continue; // §4.7 门控
    if (current.median === null) continue;
    if (rule.rule_type === "price_drop_pct") {
      await evalDropRule(env, rule, current, now, stats);
    } else {
      await evalTargetRule(env, rule, current, stats);
    }
  }
  return stats;
}

// ---------------- 系统事件：更新延迟 / 数据异常 ----------------

async function resolveCity(
  env: Env,
  objectType: string,
  objectId: string,
): Promise<string | null> {
  if (objectType === "region") {
    const row = await env.DB_PUBLIC.prepare(
      "SELECT city_code FROM regions WHERE region_id = ?",
    )
      .bind(objectId)
      .first<{ city_code: string }>();
    return row?.city_code ?? null;
  }
  if (objectType === "community") {
    const row = await env.DB_PUBLIC.prepare(
      "SELECT city_code FROM communities WHERE community_id = ?",
    )
      .bind(objectId)
      .first<{ city_code: string }>();
    return row?.city_code ?? null;
  }
  return null; // listing 无实体表（04D 未建），无法定位城市 → 跳过
}

/**
 * 系统事件评估（§2.8/§6.6）：按 watch 对象归属到每个 owner 用户。
 * - update_delayed：最新快照超 SLA（official_index 45 天/其余 10 天）；零快照不产；每用户每对象每日一条。
 * - data_anomaly：近 24h 采集任务失败（job 城市=对象城市）或来源健康 down（需城市覆盖）。
 *   注：04E 起极端值 400 不入库、rejected 行不可达，异常判定以任务失败/来源健康为准。
 * 幂等：event_key 含 watch_id 与日期/任务 ID，重复评估零新增。
 */
export async function evaluateSystemEvents(
  env: Env,
  now: Date,
): Promise<SystemEvaluation> {
  const today = shanghaiDate(now);
  const stats: SystemEvaluation = { delayed: 0, anomaly: 0, skipped: 0 };
  const watches = await env.DB_PRIVATE.prepare(
    // TASK-06B 拍板2：冻结/注销用户不产生系统事件（延迟/异常提醒同样停发）
    `SELECT w.watch_id, w.user_id, w.object_type, w.object_id, w.display_name_snapshot
       FROM watch_items w
       JOIN users u ON u.user_id = w.user_id
      WHERE w.status = 'active'
        AND u.status = 'active' AND u.deleted_at IS NULL`,
  ).all<WatchRow>();
  if (watches.results.length === 0) return stats;

  const byObject = new Map<string, WatchRow[]>();
  for (const w of watches.results) {
    const key = `${w.object_type}|${w.object_id}`;
    const list = byObject.get(key);
    if (list) list.push(w);
    else byObject.set(key, [w]);
  }

  // ---- 近 24h 异常输入（Private：任务与健康） ----
  const failedJobs = await env.DB_PRIVATE.prepare(
    `SELECT job_id, source_id, city_code, error_code
       FROM ingest_jobs
      WHERE status = 'failed'
        AND started_at >= datetime('now', ?)`,
  )
    .bind(`-${ANOMALY_WINDOW_HOURS} hours`)
    .all<{
      job_id: string;
      source_id: string;
      city_code: string;
      error_code: string | null;
    }>();
  const downReports = await env.DB_PRIVATE.prepare(
    `SELECT report_id, source_id
       FROM source_health_reports
      WHERE status = 'down'
        AND checked_at >= datetime('now', ?)`,
  )
    .bind(`-${ANOMALY_WINDOW_HOURS} hours`)
    .all<{ report_id: string; source_id: string }>();

  const cityCache = new Map<string, string | null>();
  const coverageCache = new Map<string, Set<string>>();
  const sourceNameCache = new Map<string, string>();
  const hasAnomalyInputs =
    failedJobs.results.length > 0 || downReports.results.length > 0;

  const sourceName = async (sourceId: string): Promise<string> => {
    const cached = sourceNameCache.get(sourceId);
    if (cached !== undefined) return cached;
    const row = await env.DB_PUBLIC.prepare(
      "SELECT name FROM data_sources_public WHERE source_id = ?",
    )
      .bind(sourceId)
      .first<{ name: string }>();
    const name = row?.name ?? sourceId;
    sourceNameCache.set(sourceId, name);
    return name;
  };

  for (const [key, owners] of byObject) {
    const [objectType, objectId] = key.split("|") as [string, string];

    // ---------- 更新延迟 ----------
    const latest = await env.DB_PUBLIC.prepare(
      `SELECT price_type, stat_date, source_id
         FROM price_snapshots
        WHERE object_type = ? AND object_id = ?
        ORDER BY stat_date DESC
        LIMIT 1`,
    )
      .bind(objectType, objectId)
      .first<{
        price_type: string;
        stat_date: string;
        source_id: string | null;
      }>();
    if (!latest) {
      stats.skipped += 1; // uncovered ≠ 延迟：零快照对象不产事件
    } else {
      const sla = DELAY_SLA_DAYS[latest.price_type] ?? DELAY_SLA_DEFAULT_DAYS;
      const cutoff = addDays(today, -sla);
      if (latest.stat_date < cutoff) {
        const delayDays = daysBetween(latest.stat_date, today);
        for (const w of owners) {
          const res = await createEvent(env, {
            userId: w.user_id,
            watchId: w.watch_id,
            ruleId: null,
            eventType: "update_delayed",
            eventKey: `sys|delayed|${w.watch_id}|${today}`,
            evidence: {
              object_type: objectType,
              object_id: objectId,
              display_name: w.display_name_snapshot,
              sla_days: sla,
              latest_stat_date: latest.stat_date,
              latest_source_id: latest.source_id,
              delay_days: delayDays,
              as_of: today,
              explanation: `「${w.display_name_snapshot}」最新数据日期为 ${latest.stat_date}，已滞后 ${delayDays} 天（SLA ${sla} 天），数据源可能延迟更新。`,
              evidence_lines: [
                `最新数据 ${latest.stat_date}`,
                `SLA ${sla} 天 · 滞后 ${delayDays} 天`,
                `来源 ${latest.source_id ?? "未知"}`,
                `判定日 ${today}`,
              ],
            },
          });
          if (res.created) stats.delayed += 1;
          else stats.skipped += 1;
        }
      }
    }

    // ---------- 数据异常 ----------
    if (!hasAnomalyInputs) continue;
    let city = cityCache.get(key);
    if (city === undefined) {
      city = await resolveCity(env, objectType, objectId);
      cityCache.set(key, city);
    }
    if (!city) {
      stats.skipped += 1;
      continue;
    }

    // 城市 × 来源覆盖（仅健康 down 上报需要；失败任务自带 city_code）
    let cover: Set<string> | undefined;
    if (downReports.results.length > 0) {
      cover = coverageCache.get(city);
      if (!cover) {
        const rows = await env.DB_PUBLIC.prepare(
          "SELECT source_id FROM source_city_coverage WHERE city_code = ?",
        )
          .bind(city)
          .all<{ source_id: string }>();
        cover = new Set(rows.results.map((r) => r.source_id));
        coverageCache.set(city, cover);
      }
    }

    for (const w of owners) {
      for (const job of failedJobs.results) {
        if (job.city_code !== city) continue;
        const name = await sourceName(job.source_id);
        const res = await createEvent(env, {
          userId: w.user_id,
          watchId: w.watch_id,
          ruleId: null,
          eventType: "data_anomaly",
          eventKey: `sys|anomaly|${w.watch_id}|${job.source_id}|${job.job_id}`,
          evidence: {
            trigger: "job_failed",
            job_id: job.job_id,
            source_id: job.source_id,
            source_name: name,
            city_code: city,
            error_code: job.error_code,
            window_hours: ANOMALY_WINDOW_HOURS,
            object_type: objectType,
            object_id: objectId,
            display_name: w.display_name_snapshot,
            explanation: `数据源「${name}」近 ${ANOMALY_WINDOW_HOURS} 小时在城市 ${city} 采集失败（${job.error_code ?? "unknown"}），「${w.display_name_snapshot}」的数据可能异常。`,
            evidence_lines: [
              `失败任务 ${job.job_id}`,
              `错误码 ${job.error_code ?? "unknown"}`,
              `城市 ${city}`,
              `窗口 近 ${ANOMALY_WINDOW_HOURS} 小时`,
            ],
          },
        });
        if (res.created) stats.anomaly += 1;
        else stats.skipped += 1;
      }
      for (const rep of downReports.results) {
        if (!cover || !cover.has(rep.source_id)) continue;
        const name = await sourceName(rep.source_id);
        const res = await createEvent(env, {
          userId: w.user_id,
          watchId: w.watch_id,
          ruleId: null,
          eventType: "data_anomaly",
          eventKey: `sys|anomaly|${w.watch_id}|${rep.source_id}|health|${today}`,
          evidence: {
            trigger: "source_down",
            report_id: rep.report_id,
            source_id: rep.source_id,
            source_name: name,
            city_code: city,
            window_hours: ANOMALY_WINDOW_HOURS,
            object_type: objectType,
            object_id: objectId,
            display_name: w.display_name_snapshot,
            explanation: `数据源「${name}」近 ${ANOMALY_WINDOW_HOURS} 小时健康上报为 down，「${w.display_name_snapshot}」的数据可能异常。`,
            evidence_lines: [
              `健康上报 ${rep.report_id}（down）`,
              `来源 ${name}`,
              `城市覆盖 ${city}`,
              `窗口 近 ${ANOMALY_WINDOW_HOURS} 小时`,
            ],
          },
        });
        if (res.created) stats.anomaly += 1;
        else stats.skipped += 1;
      }
    }
  }
  return stats;
}
