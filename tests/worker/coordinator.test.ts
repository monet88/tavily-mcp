import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AcquireInput,
  QuarantineInput,
} from "../../src/key-pool.js";
import {
  TavilyCoordinator,
  type RateDecision,
  type RequestLimitInput,
  type ResearchJobInput,
  type ResearchJobRecord,
} from "../../src/coordinator.js";

type CoordinatorStub = DurableObjectStub<TavilyCoordinator>;

function coordinator(name = `coord-${crypto.randomUUID()}`): CoordinatorStub {
  return env.TAVILY_COORDINATOR.get(
    env.TAVILY_COORDINATOR.idFromName(name),
  ) as CoordinatorStub;
}

function acquireInput(
  fingerprints: string[],
  overrides: Partial<AcquireInput> = {},
): AcquireInput {
  return {
    poolVersion: overrides.poolVersion ?? fingerprints.join("|"),
    fingerprints,
    nowMs: overrides.nowMs ?? Date.UTC(2026, 6, 11, 12, 0, 0),
    tavilyDailyCallLimit: overrides.tavilyDailyCallLimit ?? 1_000,
  };
}

function rateInput(overrides: Partial<RequestLimitInput> = {}): RequestLimitInput {
  return {
    nowMs: overrides.nowMs ?? Date.UTC(2026, 6, 11, 12, 0, 0),
    mcpDailyRequestLimit: overrides.mcpDailyRequestLimit ?? 10_000,
    mcpRequestsPerMinute: overrides.mcpRequestsPerMinute ?? 120,
    mcpEnabled: overrides.mcpEnabled,
  };
}

async function nextIndex(stub: CoordinatorStub): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const row = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", "nextIndex")
      .toArray()[0];
    return row ? Number(row.value) : 0;
  });
}

async function researchRows(stub: CoordinatorStub): Promise<ResearchJobRecord[]> {
  return runInDurableObject(stub, (_instance, state) => {
    return state.storage.sql
      .exec<{
        request_id: string;
        fingerprint: string;
        created_at_ms: number;
        expires_at_ms: number;
        terminal_status: string | null;
      }>("SELECT request_id, fingerprint, created_at_ms, expires_at_ms, terminal_status FROM research_jobs")
      .toArray()
      .map(row => ({
        requestId: row.request_id,
        fingerprint: row.fingerprint,
        createdAtMs: row.created_at_ms,
        expiresAtMs: row.expires_at_ms,
        terminalStatus: (row.terminal_status ?? null) as ResearchJobRecord["terminalStatus"],
      }));
  });
}

async function counterBuckets(stub: CoordinatorStub): Promise<string[]> {
  return runInDurableObject(stub, (_instance, state) => {
    return state.storage.sql
      .exec<{ bucket: string }>("SELECT bucket FROM counters ORDER BY bucket")
      .toArray()
      .map(row => row.bucket);
  });
}

describe("TavilyCoordinator", () => {
  it("rotates leases a → b → c → a across concurrent RPC callers", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b", "fp-c"];
    const input = acquireInput(fingerprints);

    const firstWave = await Promise.all([
      stub.acquireForTavily(input),
      stub.acquireForTavily(input),
      stub.acquireForTavily(input),
    ]);
    expect(firstWave.map(d => (d.allowed ? d.fingerprint : d.code))).toEqual([
      "fp-a",
      "fp-b",
      "fp-c",
    ]);

    const fourth = await stub.acquireForTavily(input);
    expect(fourth).toEqual({ allowed: true, fingerprint: "fp-a" });
  });

  it("does not advance the cursor on kill-switch or rate rejection", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b"];

    const disabled = await stub.allowMcpRequest(
      rateInput({ mcpEnabled: false }),
    );
    expect(disabled).toEqual({ allowed: false, code: "SERVICE_DISABLED" });
    expect(await nextIndex(stub)).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      const decision = await stub.allowMcpRequest(
        rateInput({
          nowMs: Date.UTC(2026, 6, 11, 12, 0, i),
          mcpDailyRequestLimit: 2,
          mcpRequestsPerMinute: 100,
        }),
      );
      expect(decision.allowed).toBe(true);
    }
    const dailyDenied = await stub.allowMcpRequest(
      rateInput({
        nowMs: Date.UTC(2026, 6, 11, 12, 0, 2),
        mcpDailyRequestLimit: 2,
        mcpRequestsPerMinute: 100,
      }),
    );
    expect(dailyDenied).toMatchObject({
      allowed: false,
      code: "DAILY_LIMIT_REACHED",
    });
    expect(await nextIndex(stub)).toBe(0);

    const lease = await stub.acquireForTavily(acquireInput(fingerprints));
    expect(lease).toEqual({ allowed: true, fingerprint: "fp-a" });
  });

  it("research fingerprint resolution does not acquire a new lease", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b"];
    const first = await stub.acquireForTavily(acquireInput(fingerprints));
    expect(first).toEqual({ allowed: true, fingerprint: "fp-a" });

    const now = Date.now();
    await stub.putResearchJob({
      requestId: "req-1",
      fingerprint: "fp-a",
      tokenHash: "th-test",
      createdAtMs: now,
      expiresAtMs: now + 86_400_000,
    });

    const job = await stub.getResearchJob("req-1");
    expect(job?.fingerprint).toBe("fp-a");
    expect(await nextIndex(stub)).toBe(1);
    const second = await stub.acquireForTavily(acquireInput(fingerprints));
    expect(second).toEqual({ allowed: true, fingerprint: "fp-b" });
  });

  it("resets the cursor to index zero when poolVersion changes", async () => {
    const stub = coordinator();
    const v1 = acquireInput(["fp-a", "fp-b", "fp-c"], { poolVersion: "v1" });
    expect(await stub.acquireForTavily(v1)).toEqual({
      allowed: true,
      fingerprint: "fp-a",
    });
    expect(await stub.acquireForTavily(v1)).toEqual({
      allowed: true,
      fingerprint: "fp-b",
    });
    expect(await nextIndex(stub)).toBe(2);

    const v2 = acquireInput(["fp-x", "fp-y"], { poolVersion: "v2" });
    expect(await stub.acquireForTavily(v2)).toEqual({
      allowed: true,
      fingerprint: "fp-x",
    });
    expect(await nextIndex(stub)).toBe(1);
  });

  it("persists nextIndex=0 on poolVersion change even when first acquire fails", async () => {
    const stub = coordinator();
    const t0 = Date.UTC(2026, 6, 11, 12, 0, 0);
    const v1 = acquireInput(["fp-a", "fp-b", "fp-c"], {
      poolVersion: "v1",
      nowMs: t0,
    });

    // Advance cursor mid-pool on v1: a then b -> nextIndex=2.
    expect(await stub.acquireForTavily(v1)).toEqual({
      allowed: true,
      fingerprint: "fp-a",
    });
    expect(await stub.acquireForTavily(v1)).toEqual({
      allowed: true,
      fingerprint: "fp-b",
    });
    expect(await nextIndex(stub)).toBe(2);

    // Switch to v2 with every key quarantined -> KEY_POOL_UNAVAILABLE.
    const v2fps = ["fp-x", "fp-y", "fp-z"];
    for (const fp of v2fps) {
      await stub.quarantine({ fingerprint: fp, untilMs: t0 + 60_000 });
    }
    const denied = await stub.acquireForTavily(
      acquireInput(v2fps, { poolVersion: "v2", nowMs: t0 + 1_000 }),
    );
    expect(denied).toEqual({ allowed: false, code: "KEY_POOL_UNAVAILABLE" });
    // Cursor reset must have been persisted despite the failed scan.
    expect(await nextIndex(stub)).toBe(0);

    // Clear quarantines and re-acquire: must start at index 0 (x), not z.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM quarantines");
    });
    const next = await stub.acquireForTavily(
      acquireInput(v2fps, { poolVersion: "v2", nowMs: t0 + 2_000 }),
    );
    expect(next).toEqual({ allowed: true, fingerprint: "fp-x" });
    expect(await nextIndex(stub)).toBe(1);
  });

  it("skips quarantined keys and restores them after untilMs", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b"];
    const t0 = Date.UTC(2026, 6, 11, 12, 0, 0);

    const first = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 }),
    );
    expect(first).toEqual({ allowed: true, fingerprint: "fp-a" });

    await stub.quarantine({ fingerprint: "fp-a", untilMs: t0 + 10_000 });

    const second = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 + 1_000 }),
    );
    expect(second).toEqual({ allowed: true, fingerprint: "fp-b" });

    const third = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 + 2_000 }),
    );
    expect(third).toEqual({ allowed: true, fingerprint: "fp-b" });

    const restored = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 + 10_001 }),
    );
    expect(restored).toEqual({ allowed: true, fingerprint: "fp-a" });
  });

  it("quarantine is explicit (401 only via caller) and does not require status codes", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b"];
    const t0 = Date.UTC(2026, 6, 11, 12, 0, 0);

    await stub.quarantine({ fingerprint: "fp-a", untilMs: t0 + 60_000 } satisfies QuarantineInput);

    const decision = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 }),
    );
    expect(decision).toEqual({ allowed: true, fingerprint: "fp-b" });
  });

  it("enforces UTC daily counters and per-minute counters for MCP requests", async () => {
    const stub = coordinator();
    const day1 = Date.UTC(2026, 6, 11, 23, 59, 0);
    const day2 = Date.UTC(2026, 6, 12, 0, 0, 0);

    expect(
      await stub.allowMcpRequest(
        rateInput({ nowMs: day1, mcpDailyRequestLimit: 1, mcpRequestsPerMinute: 10 }),
      ),
    ).toEqual({ allowed: true });
    expect(
      await stub.allowMcpRequest(
        rateInput({ nowMs: day1, mcpDailyRequestLimit: 1, mcpRequestsPerMinute: 10 }),
      ),
    ).toMatchObject({ allowed: false, code: "DAILY_LIMIT_REACHED" });

    expect(
      await stub.allowMcpRequest(
        rateInput({ nowMs: day2, mcpDailyRequestLimit: 1, mcpRequestsPerMinute: 10 }),
      ),
    ).toEqual({ allowed: true });

    const minuteBase = Date.UTC(2026, 6, 12, 1, 0, 0);
    const stub2 = coordinator();
    expect(
      await stub2.allowMcpRequest(
        rateInput({
          nowMs: minuteBase,
          mcpDailyRequestLimit: 100,
          mcpRequestsPerMinute: 1,
        }),
      ),
    ).toEqual({ allowed: true });
    const limited: RateDecision = await stub2.allowMcpRequest(
      rateInput({
        nowMs: minuteBase + 1_000,
        mcpDailyRequestLimit: 100,
        mcpRequestsPerMinute: 1,
      }),
    );
    expect(limited).toMatchObject({
      allowed: false,
      code: "RATE_LIMITED",
    });
    if (!limited.allowed && limited.code === "RATE_LIMITED") {
      expect(limited.retryAfterSeconds).toBeGreaterThan(0);
      expect(limited.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it("prunes stale minute counter buckets on MCP traffic without research jobs", async () => {
    const stub = coordinator();
    // No research jobs at all — alarm path never arms.
    const m0 = Date.UTC(2026, 6, 11, 12, 0, 0);
    const m1 = Date.UTC(2026, 6, 11, 12, 1, 0);
    const m2 = Date.UTC(2026, 6, 11, 12, 2, 0);
    const later = Date.UTC(2026, 6, 11, 15, 0, 0);

    for (const nowMs of [m0, m1, m2]) {
      expect(
        await stub.allowMcpRequest(
          rateInput({ nowMs, mcpDailyRequestLimit: 100, mcpRequestsPerMinute: 10 }),
        ),
      ).toEqual({ allowed: true });
    }

    const mid = await counterBuckets(stub);
    // After m2 request, only current day + current minute should remain.
    expect(mid.some(b => b.startsWith("mcp_minute:2026-07-11T12:00"))).toBe(false);
    expect(mid.some(b => b.startsWith("mcp_minute:2026-07-11T12:01"))).toBe(false);
    expect(mid.some(b => b.startsWith("mcp_minute:2026-07-11T12:02"))).toBe(true);

    // Far-future request must drop the 12:02 bucket too.
    expect(
      await stub.allowMcpRequest(
        rateInput({ nowMs: later, mcpDailyRequestLimit: 100, mcpRequestsPerMinute: 10 }),
      ),
    ).toEqual({ allowed: true });

    const after = await counterBuckets(stub);
    expect(after.some(b => b.startsWith("mcp_minute:2026-07-11T12:"))).toBe(false);
    expect(after.some(b => b.startsWith("mcp_minute:2026-07-11T15:00"))).toBe(true);
    expect(after.some(b => b === "mcp_day:2026-07-11")).toBe(true);
  });

  it("enforces UTC daily Tavily call counters without advancing cursor on reject", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b"];
    const t0 = Date.UTC(2026, 6, 11, 12, 0, 0);

    expect(
      await stub.acquireForTavily(
        acquireInput(fingerprints, { nowMs: t0, tavilyDailyCallLimit: 1 }),
      ),
    ).toEqual({ allowed: true, fingerprint: "fp-a" });
    expect(await nextIndex(stub)).toBe(1);

    const denied = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 + 1_000, tavilyDailyCallLimit: 1 }),
    );
    expect(denied).toEqual({ allowed: false, code: "DAILY_LIMIT_REACHED" });
    expect(await nextIndex(stub)).toBe(1);

    const nextDay = Date.UTC(2026, 6, 12, 0, 0, 0);
    expect(
      await stub.acquireForTavily(
        acquireInput(fingerprints, { nowMs: nextDay, tavilyDailyCallLimit: 1 }),
      ),
    ).toEqual({ allowed: true, fingerprint: "fp-b" });
  });

  it("stores research metadata without raw keys or report content", async () => {
    const stub = coordinator();
    const now = Date.now();
    const input: ResearchJobInput = {
      requestId: "req-meta",
      fingerprint: "fp-a",
      tokenHash: "th-meta",
      createdAtMs: now,
      expiresAtMs: now + 86_400_000,
    };
    await stub.putResearchJob(input);

    const job = await stub.getResearchJob("req-meta");
    expect(job).toEqual({
      requestId: "req-meta",
      fingerprint: "fp-a",
      tokenHash: "th-meta",
      createdAtMs: now,
      expiresAtMs: now + 86_400_000,
      terminalStatus: null,
    });

    await runInDurableObject(stub, (_instance, state) => {
      const rows = state.storage.sql
        .exec("SELECT * FROM research_jobs")
        .toArray();
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toMatch(/tvly-|sk-|api-key|report|content/i);
      expect(serialized).toContain("fp-a");
      expect(serialized).toContain("req-meta");
    });
  });

  it("keeps terminal metadata until TTL and sweeps on alarm and opportunistic read", async () => {
    const stub = coordinator();
    const created = Date.now();
    const expires = created + 60_000;

    await stub.putResearchJob({
      requestId: "req-term",
      fingerprint: "fp-a",
      tokenHash: "th-test",
      createdAtMs: created,
      expiresAtMs: expires,
    });
    await stub.markResearchTerminal("req-term", "completed");

    const before = await stub.getResearchJob("req-term");
    expect(before?.terminalStatus).toBe("completed");

    await runInDurableObject(stub, instance => {
      instance.sweepExpired(expires - 1);
    });
    expect(await stub.getResearchJob("req-term")).not.toBeNull();

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(expires);
    });
    const ran = await runDurableObjectAlarm(stub);
    expect(ran).toBe(true);

    // Alarm uses Date.now(); force post-expiry sweep for determinism.
    await runInDurableObject(stub, instance => {
      instance.sweepExpired(expires + 1);
    });
    expect(await stub.getResearchJob("req-term")).toBeNull();
    expect(await researchRows(stub)).toEqual([]);
  });

  it("opportunistic sweep on put/get deletes expired rows", async () => {
    const stub = coordinator();
    const t0 = Date.now() - 10_000;

    await stub.putResearchJob({
      requestId: "old",
      fingerprint: "fp-a",
      tokenHash: "th-test",
      createdAtMs: t0,
      expiresAtMs: t0 + 1_000, // already expired relative to next put's createdAtMs
    });

    // putResearchJob sweeps using input.createdAtMs as "now".
    await stub.putResearchJob({
      requestId: "new",
      fingerprint: "fp-b",
      tokenHash: "th-test",
      createdAtMs: t0 + 5_000,
      expiresAtMs: Date.now() + 86_400_000,
    });

    // Verify via SQL so getResearchJob wall-clock sweep is not the subject.
    const rows = await researchRows(stub);
    expect(rows.map(r => r.requestId)).toEqual(["new"]);
    expect(rows[0]?.fingerprint).toBe("fp-b");

    // getResearchJob also opportunistically sweeps.
    expect(await stub.getResearchJob("old")).toBeNull();
    expect(await stub.getResearchJob("new")).toMatchObject({
      requestId: "new",
      fingerprint: "fp-b",
    });
  });

  it("returns RESEARCH_STORAGE_FULL when the 2000-row cap is reached", async () => {
    const stub = coordinator();
    const t0 = Date.now();

    await runInDurableObject(stub, (_instance, state) => {
      for (let i = 0; i < 2000; i += 1) {
        state.storage.sql.exec(
          `INSERT INTO research_jobs (request_id, fingerprint, token_hash, created_at_ms, expires_at_ms, terminal_status)
           VALUES (?, ?, ?, ?, ?, NULL)`,
          `seed-${i}`,
          "fp-a",
          "th-seed",
          t0,
          t0 + 86_400_000,
        );
      }
    });

    let message = "";
    try {
      await stub.putResearchJob({
        requestId: "overflow",
        fingerprint: "fp-b",
      tokenHash: "th-test",
        createdAtMs: t0 + 1,
        expiresAtMs: t0 + 86_400_000,
      });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/RESEARCH_STORAGE_FULL/);
  });

  it("runs the critical cursor transaction with no upstream async work", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b", "fp-c"];

    await runInDurableObject(stub, async instance => {
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
        fetchCalls += 1;
        throw new Error("unexpected fetch in coordinator");
      }) as typeof fetch;

      try {
        const decision = instance.acquireForTavilySync(
          acquireInput(fingerprints, {
            nowMs: Date.UTC(2026, 6, 11, 12, 0, 0),
          }),
        );
        expect(decision).toEqual({ allowed: true, fingerprint: "fp-a" });
        expect(fetchCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        stub.acquireForTavily(acquireInput(fingerprints)),
      ),
    );
    expect(
      results.map(d => (d.allowed ? d.fingerprint : d.code)),
    ).toEqual(["fp-b", "fp-c", "fp-a", "fp-b", "fp-c", "fp-a"]);
  });

  it("returns KEY_POOL_UNAVAILABLE when every key is quarantined without moving cursor", async () => {
    const stub = coordinator();
    const fingerprints = ["fp-a", "fp-b"];
    const t0 = Date.UTC(2026, 6, 11, 12, 0, 0);

    await stub.quarantine({ fingerprint: "fp-a", untilMs: t0 + 60_000 });
    await stub.quarantine({ fingerprint: "fp-b", untilMs: t0 + 60_000 });

    const decision = await stub.acquireForTavily(
      acquireInput(fingerprints, { nowMs: t0 }),
    );
    expect(decision).toEqual({ allowed: false, code: "KEY_POOL_UNAVAILABLE" });
    expect(await nextIndex(stub)).toBe(0);
  });

  it("stores tokenHash and returns it on getResearchJob", async () => {
    const stub = coordinator();
    const created = Date.now();
    await stub.putResearchJob({
      requestId: "req-auth",
      fingerprint: "fp-a",
      tokenHash: "hash-abc",
      createdAtMs: created,
      expiresAtMs: created + 60_000,
    });
    const row = await stub.getResearchJob("req-auth");
    expect(row).toMatchObject({
      requestId: "req-auth",
      fingerprint: "fp-a",
      tokenHash: "hash-abc",
    });
  });

});
