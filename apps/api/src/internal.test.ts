// TASK-04A：internal 批次端点与来源门禁验收（PRD 任务行 1284–1286 / §10.4 / §5.6 / §11.1）
// 核心验收：
//   验收一 pending_review + 合法签名 → 403 source_not_approved（不落批次）；
//   验收二 approved 批次受理后 suspend → 下一批 403（无新批次行）；
// 另覆盖：超范围批次、未知来源、过期自动 suspend、签名链（缺 secret/时间戳/nonce/篡改 body）与受理记录。
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { createTestEnv, type TestContext } from "./test-utils/setup";

let ctx: TestContext;
let app: ReturnType<typeof createApp>;

const SECRET = "test-ingest-secret-04a";
const CITY = "TEST-0001";
const SOURCE = "src_official";

beforeEach(() => {
  ctx = createTestEnv();
  app = createApp();
  ctx.env.INGEST_HMAC_SECRET = SECRET; // 未配置的场景由单测内 delete 覆盖
  seedCity(CITY, "active");
});

function seedCity(code: string, status: string): void {
  ctx.pub
    .prepare(
      "INSERT INTO cities (city_code, name, province_code, status) VALUES (?, ?, 'TEST-P', ?)",
    )
    .run(code, `TEST-城市${code}`, status);
}

function seedSource(status: string, validUntil: string | null = null): void {
  ctx.pub
    .prepare(
      "INSERT INTO data_sources_public (source_id, name, source_type) VALUES (?, 'TEST-官方来源（虚构）', 'open_data')",
    )
    .run(SOURCE);
  ctx.pub
    .prepare(
      "INSERT INTO source_license_state (source_id, status, valid_until) VALUES (?, ?, ?)",
    )
    .run(SOURCE, status, validUntil);
}

function seedCoverage(
  cityCode = CITY,
  level = "community",
  authz = "approved_open",
): void {
  ctx.pub
    .prepare(
      `INSERT INTO source_city_coverage
         (source_id, city_code, object_level, metric_codes_json, authorization_status, last_verified_at)
       VALUES (?, ?, ?, '["community_ask_median_unit"]', ?, datetime('now'))`,
    )
    .run(SOURCE, cityCode, level, authz);
}

/** HMAC-SHA256 → 小写 hex（与 runtime 口径一致：`${ts}.${nonce}.${body}`） */
async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let nonceSeq = 0;
function newNonce(): string {
  nonceSeq += 1;
  return `nonce-${String(nonceSeq).padStart(4, "0")}-04a`;
}

interface SignOpts {
  secret?: string;
  ts?: string;
  nonce?: string;
  /** 覆盖签名计算（默认对原始 body 签名） */
  signBody?: string;
}

function defaultPayload(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: "batch_04a_001",
    source_id: SOURCE,
    city_code: CITY,
    object_level: "community",
    observed_count: 42,
    ...overrides,
  };
}

async function postBatch(
  payload: unknown,
  opts: SignOpts = {},
): Promise<Response> {
  const raw = JSON.stringify(payload);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? newNonce();
  const secret = opts.secret ?? SECRET;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Ingest-Timestamp": ts,
    "X-Ingest-Nonce": nonce,
    "X-Ingest-Signature": await hmacHex(
      secret,
      `${ts}.${nonce}.${opts.signBody ?? raw}`,
    ),
  };
  return app.request(
    "/api/v1/internal/ingest/batch",
    { method: "POST", headers, body: raw },
    ctx.env,
  );
}

function batchCount(): number {
  return (
    ctx.priv.prepare("SELECT COUNT(*) AS n FROM ingest_batches").get() as {
      n: number;
    }
  ).n;
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error_code: string }).error_code;
}

describe("验收一：未审批来源不可入管线", () => {
  it("pending_review + 合法签名 → 403 source_not_approved，不写 ingest_batches", async () => {
    seedSource("pending_review");
    seedCoverage();
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");
    expect(batchCount()).toBe(0);
  });
});

describe("验收二：停用后下一批任务不得执行", () => {
  it("approved 批次 202 受理 → suspend → 下一批 403（无新批次行）", async () => {
    seedSource("approved_open");
    seedCoverage();
    const first = await postBatch(defaultPayload());
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({
      batch_id: "batch_04a_001",
      status: "accepted",
    });
    expect(batchCount()).toBe(1);

    // 停用（与 POST /admin/sources/:id/suspend 同一 SQL 语义）
    ctx.pub
      .prepare(
        "UPDATE source_license_state SET status = 'suspended' WHERE source_id = ?",
      )
      .run(SOURCE);
    ctx.pub
      .prepare(
        "UPDATE source_city_coverage SET authorization_status = 'suspended' WHERE source_id = ?",
      )
      .run(SOURCE);

    const second = await postBatch(
      defaultPayload({ batch_id: "batch_04a_002" }),
    );
    expect(second.status).toBe(403);
    expect(await errCode(second)).toBe("source_not_approved");
    expect(batchCount()).toBe(1);
  });

  it("discovered/manual_only/未知来源同样被拒（403/404）", async () => {
    seedSource("manual_only");
    seedCoverage();
    expect((await postBatch(defaultPayload())).status).toBe(403);

    // 未知 source：404 source_not_found（须有 coverage 的假来源不在 data_sources_public 中）
    const res = await postBatch(
      defaultPayload({ source_id: "src_ghost", batch_id: "b_ghost" }),
    );
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe("source_not_found");
  });
});

describe("超范围批次被拒绝（PRD 04A「拒绝超范围批次」）", () => {
  it("缺 coverage 行 → 403 city_coverage_denied", async () => {
    seedSource("approved_open"); // 未 seedCoverage
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
    expect(batchCount()).toBe(0);
  });

  it("object_level 超范围 → 403", async () => {
    seedSource("approved_open");
    seedCoverage(CITY, "community");
    const res = await postBatch(
      defaultPayload({ object_level: "listing", batch_id: "b_lvl" }),
    );
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
  });

  it("城市不在 coverage → 403；城市 status 非 active/limited → 403", async () => {
    seedCity("TEST-0002", "requestable");
    seedSource("approved_open");
    seedCoverage();
    const otherCity = await postBatch(
      defaultPayload({ city_code: "TEST-0002", batch_id: "b_city" }),
    );
    expect(otherCity.status).toBe(403);
    expect(await errCode(otherCity)).toBe("city_coverage_denied");

    // 城市被停采（目录在、coverage 在，但城市 status=suspended）
    ctx.pub
      .prepare("UPDATE cities SET status = 'suspended' WHERE city_code = ?")
      .run(CITY);
    const suspended = await postBatch(defaultPayload({ batch_id: "b_city2" }));
    expect(suspended.status).toBe(403);
    expect(await errCode(suspended)).toBe("city_coverage_denied");
  });

  it("coverage 授权未批准（pending_review/suspended 行）→ 403", async () => {
    seedSource("approved_open");
    seedCoverage(CITY, "community", "pending_review");
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("city_coverage_denied");
  });
});

describe("授权到期自动 suspend（惰性）", () => {
  it("valid_until 已过 → 批次 403 且库中状态已 suspended + 覆盖同步 + 审计留痕", async () => {
    seedSource("approved_open", "2020-01-01");
    seedCoverage();
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("source_not_approved");

    expect(
      (
        ctx.pub
          .prepare(
            "SELECT status FROM source_license_state WHERE source_id = ?",
          )
          .get(SOURCE) as { status: string }
      ).status,
    ).toBe("suspended");
    expect(
      (
        ctx.pub
          .prepare(
            "SELECT authorization_status FROM source_city_coverage WHERE source_id = ?",
          )
          .get(SOURCE) as { authorization_status: string }
      ).authorization_status,
    ).toBe("suspended");
    expect(
      ctx.priv
        .prepare("SELECT action, reason FROM audit_logs WHERE resource_id = ?")
        .get(SOURCE) as { action: string; reason: string },
    ).toMatchObject({
      action: "source.auto_suspend",
      reason: "license_expired",
    });
  });

  it("valid_until 未过 → 批次受理成功", async () => {
    const future = new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
    seedSource("approved_licensed", future);
    seedCoverage();
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(202);
  });
});

describe("HMAC 签名与防重放", () => {
  beforeEach(() => {
    seedSource("approved_open");
    seedCoverage();
  });

  it("未配置 INGEST_HMAC_SECRET → 403 ingest_disabled", async () => {
    delete ctx.env.INGEST_HMAC_SECRET;
    const res = await postBatch(defaultPayload());
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("ingest_disabled");
    expect(batchCount()).toBe(0);
  });

  it("错误签名 → 403 signature_invalid", async () => {
    const res = await postBatch(defaultPayload(), {
      secret: "wrong-secret-04a",
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("signature_invalid");
    expect(batchCount()).toBe(0);
  });

  it("body 被篡改（签名覆盖原文）→ 403 signature_invalid", async () => {
    const payload = defaultPayload();
    const tampered = { ...payload, object_level: "listing" };
    const res = await postBatch(tampered, {
      signBody: JSON.stringify(payload),
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("signature_invalid");
  });

  it("时间戳偏差 >300s → 403 stale_timestamp", async () => {
    const stale = String(Math.floor(Date.now() / 1000) - 400);
    const res = await postBatch(defaultPayload({ batch_id: "b_stale" }), {
      ts: stale,
    });
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("stale_timestamp");
  });

  it("缺失/非法 nonce → 403 replay_detected", async () => {
    const raw = JSON.stringify(defaultPayload({ batch_id: "b_nononce" }));
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await app.request(
      "/api/v1/internal/ingest/batch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ingest-Timestamp": ts,
          "X-Ingest-Signature": await hmacHex(SECRET, `${ts}..${raw}`),
        },
        body: raw,
      },
      ctx.env,
    );
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe("replay_detected");
  });

  it("重放同 (timestamp, nonce, body) → 403 replay_detected", async () => {
    const payload = defaultPayload({ batch_id: "b_replay" });
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = "replay-nonce-04a";
    const first = await postBatch(payload, { ts, nonce });
    expect(first.status).toBe(202);
    const second = await postBatch(payload, { ts, nonce });
    expect(second.status).toBe(403);
    expect(await errCode(second)).toBe("replay_detected");
    expect(batchCount()).toBe(1);
  });

  it("受理记录字段正确；同 batch_id 换 nonce 再交 → 202 duplicate（幂等，不重复写入）", async () => {
    const res = await postBatch(defaultPayload({ batch_id: "b_dup" }));
    expect(res.status).toBe(202);
    const row = ctx.priv
      .prepare(
        "SELECT source_id, city_code, object_level FROM ingest_batches WHERE batch_id = ?",
      )
      .get("b_dup") as {
      source_id: string;
      city_code: string;
      object_level: string;
    };
    expect(row).toEqual({
      source_id: SOURCE,
      city_code: CITY,
      object_level: "community",
    });

    const again = await postBatch(defaultPayload({ batch_id: "b_dup" }));
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({
      batch_id: "b_dup",
      status: "duplicate",
    });
    expect(batchCount()).toBe(1);
  });

  it("签名通过但 body 不符合 schema → 400 validation_failed", async () => {
    const payload: Record<string, unknown> = defaultPayload();
    delete payload["city_code"];
    const res = await postBatch(payload);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe("validation_failed");
    expect(batchCount()).toBe(0);
  });
});
