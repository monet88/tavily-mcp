import { DurableObject } from "cloudflare:workers";
import type {
  AcquireDecision,
  AcquireInput,
  QuarantineInput,
} from "./key-pool.js";

export type RequestLimitInput = {
  nowMs: number;
  mcpDailyRequestLimit: number;
  mcpRequestsPerMinute: number;
  mcpEnabled?: boolean;
};

export type RateDecision =
  | { allowed: true }
  | {
      allowed: false;
      code: "SERVICE_DISABLED" | "DAILY_LIMIT_REACHED" | "RATE_LIMITED";
      retryAfterSeconds?: number;
    };

export type ResearchJobInput = {
  requestId: string;
  fingerprint: string;
  createdAtMs: number;
  expiresAtMs: number;
};

export type ResearchJobRecord = {
  requestId: string;
  fingerprint: string;
  createdAtMs: number;
  expiresAtMs: number;
  terminalStatus?: "completed" | "failed" | null;
};

const STATE_POOL_VERSION = "poolVersion";
const STATE_NEXT_INDEX = "nextIndex";
const DEFAULT_MAX_RESEARCH_JOBS = 2_000;

type CounterKind = "mcp_day" | "mcp_minute" | "tavily_day";

function utcDayBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

function utcMinuteBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

function secondsUntilNextUtcMinute(nowMs: number): number {
  const next = Math.floor(nowMs / 60_000) * 60_000 + 60_000;
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}

export class TavilyCoordinator extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quarantines (
        fingerprint TEXT PRIMARY KEY,
        until_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        bucket TEXT PRIMARY KEY,
        count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_jobs (
        request_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        terminal_status TEXT
      );
    `);
  }

  async allowMcpRequest(input: RequestLimitInput): Promise<RateDecision> {
    return this.allowMcpRequestSync(input);
  }

  allowMcpRequestSync(input: RequestLimitInput): RateDecision {
    if (input.mcpEnabled === false) {
      return { allowed: false, code: "SERVICE_DISABLED" };
    }

    return this.ctx.storage.transactionSync(() => {
      const dayKey = this.counterKey("mcp_day", utcDayBucket(input.nowMs));
      const minuteKey = this.counterKey("mcp_minute", utcMinuteBucket(input.nowMs));
      const dayCount = this.getCounter(dayKey);
      if (dayCount >= input.mcpDailyRequestLimit) {
        return { allowed: false, code: "DAILY_LIMIT_REACHED" };
      }
      const minuteCount = this.getCounter(minuteKey);
      if (minuteCount >= input.mcpRequestsPerMinute) {
        return {
          allowed: false,
          code: "RATE_LIMITED",
          retryAfterSeconds: secondsUntilNextUtcMinute(input.nowMs),
        };
      }
      this.incrementCounter(dayKey);
      this.incrementCounter(minuteKey);
      return { allowed: true };
    });
  }

  async acquireForTavily(input: AcquireInput): Promise<AcquireDecision> {
    return this.acquireForTavilySync(input);
  }

  /**
   * Synchronous cursor transaction — no await / fetch inside.
   * Exposed for tests that assert the critical section is sync-only.
   */
  acquireForTavilySync(input: AcquireInput): AcquireDecision {
    if (!Array.isArray(input.fingerprints) || input.fingerprints.length === 0) {
      return { allowed: false, code: "KEY_POOL_UNAVAILABLE" };
    }

    return this.ctx.storage.transactionSync(() => {
      const dayKey = this.counterKey("tavily_day", utcDayBucket(input.nowMs));
      const dayCount = this.getCounter(dayKey);
      if (dayCount >= input.tavilyDailyCallLimit) {
        return { allowed: false, code: "DAILY_LIMIT_REACHED" };
      }

      const storedVersion = this.getState(STATE_POOL_VERSION);
      let nextIndex = this.getStateNumber(STATE_NEXT_INDEX, 0);
      if (storedVersion !== input.poolVersion) {
        this.setState(STATE_POOL_VERSION, input.poolVersion);
        nextIndex = 0;
        // Drop quarantines for fingerprints no longer in the pool.
        this.pruneQuarantines(new Set(input.fingerprints));
      }

      const count = input.fingerprints.length;
      for (let offset = 0; offset < count; offset += 1) {
        const index = (nextIndex + offset) % count;
        const fingerprint = input.fingerprints[index]!;
        if (this.isQuarantined(fingerprint, input.nowMs)) continue;

        const newNext = (index + 1) % count;
        this.setState(STATE_NEXT_INDEX, String(newNext));
        this.incrementCounter(dayKey);
        return { allowed: true, fingerprint };
      }

      // All keys quarantined — cursor must not move.
      return { allowed: false, code: "KEY_POOL_UNAVAILABLE" };
    });
  }

  async quarantine(input: QuarantineInput): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO quarantines (fingerprint, until_ms) VALUES (?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET until_ms = excluded.until_ms`,
      input.fingerprint,
      input.untilMs,
    );
  }

  async putResearchJob(input: ResearchJobInput): Promise<void> {
    // Opportunistic sweep uses the job's created time as "now".
    this.sweepExpired(input.createdAtMs);

    const maxJobs = this.maxResearchJobs();
    const existing = this.ctx.storage.sql
      .exec<{ c: number }>("SELECT COUNT(*) AS c FROM research_jobs")
      .one().c;
    const already = this.ctx.storage.sql
      .exec<{ c: number }>(
        "SELECT COUNT(*) AS c FROM research_jobs WHERE request_id = ?",
        input.requestId,
      )
      .one().c;

    if (already === 0 && existing >= maxJobs) {
      throw new Error("RESEARCH_STORAGE_FULL");
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO research_jobs (request_id, fingerprint, created_at_ms, expires_at_ms, terminal_status)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(request_id) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         created_at_ms = excluded.created_at_ms,
         expires_at_ms = excluded.expires_at_ms`,
      input.requestId,
      input.fingerprint,
      input.createdAtMs,
      input.expiresAtMs,
    );

    await this.scheduleEarliestAlarm();
  }

  async getResearchJob(requestId: string): Promise<ResearchJobRecord | null> {
    // Opportunistic sweep with wall clock so expired rows disappear on read.
    this.sweepExpired(Date.now());
    const row = this.ctx.storage.sql
      .exec<{
        request_id: string;
        fingerprint: string;
        created_at_ms: number;
        expires_at_ms: number;
        terminal_status: string | null;
      }>(
        `SELECT request_id, fingerprint, created_at_ms, expires_at_ms, terminal_status
         FROM research_jobs WHERE request_id = ?`,
        requestId,
      )
      .toArray()[0];
    if (!row) return null;
    return {
      requestId: row.request_id,
      fingerprint: row.fingerprint,
      createdAtMs: row.created_at_ms,
      expiresAtMs: row.expires_at_ms,
      terminalStatus: (row.terminal_status as ResearchJobRecord["terminalStatus"]) ?? null,
    };
  }

  async markResearchTerminal(
    requestId: string,
    status: "completed" | "failed",
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE research_jobs SET terminal_status = ? WHERE request_id = ?`,
      status,
      requestId,
    );
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.sweepExpired(nowMs);
    this.sweepStaleCounters(nowMs);
    await this.scheduleEarliestAlarm();
  }

  /** Public for tests that drive opportunistic sweeps with a fixed clock. */
  sweepExpired(nowMs: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM research_jobs WHERE expires_at_ms <= ?`,
      nowMs,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM quarantines WHERE until_ms <= ?`,
      nowMs,
    );
  }

  private sweepStaleCounters(nowMs: number): void {
    const day = utcDayBucket(nowMs);
    const minute = utcMinuteBucket(nowMs);
    // Keep current day + current minute buckets; drop older ones.
    this.ctx.storage.sql.exec(
      `DELETE FROM counters
       WHERE (bucket LIKE 'mcp_day:%' AND bucket != ?)
          OR (bucket LIKE 'tavily_day:%' AND bucket != ?)
          OR (bucket LIKE 'mcp_minute:%' AND bucket != ?)`,
      this.counterKey("mcp_day", day),
      this.counterKey("tavily_day", day),
      this.counterKey("mcp_minute", minute),
    );
  }

  private async scheduleEarliestAlarm(): Promise<void> {
    const row = this.ctx.storage.sql
      .exec<{ expires_at_ms: number }>(
        `SELECT expires_at_ms FROM research_jobs ORDER BY expires_at_ms ASC LIMIT 1`,
      )
      .toArray()[0];
    if (!row) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(row.expires_at_ms);
  }

  private maxResearchJobs(): number {
    const raw = (this.env as Cloudflare.Env).MAX_RESEARCH_JOBS;
    const n = raw ? Number(raw) : DEFAULT_MAX_RESEARCH_JOBS;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_RESEARCH_JOBS;
  }

  private counterKey(kind: CounterKind, bucket: string): string {
    return `${kind}:${bucket}`;
  }

  private getCounter(key: string): number {
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT count FROM counters WHERE bucket = ?", key)
      .toArray()[0];
    return row?.count ?? 0;
  }

  private incrementCounter(key: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO counters (bucket, count) VALUES (?, 1)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1`,
      key,
    );
  }

  private getState(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM state WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  private getStateNumber(key: string, fallback: number): number {
    const raw = this.getState(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  }

  private setState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private isQuarantined(fingerprint: string, nowMs: number): boolean {
    const row = this.ctx.storage.sql
      .exec<{ until_ms: number }>(
        "SELECT until_ms FROM quarantines WHERE fingerprint = ?",
        fingerprint,
      )
      .toArray()[0];
    if (!row) return false;
    if (row.until_ms <= nowMs) {
      this.ctx.storage.sql.exec(
        "DELETE FROM quarantines WHERE fingerprint = ?",
        fingerprint,
      );
      return false;
    }
    return true;
  }

  private pruneQuarantines(keep: Set<string>): void {
    const rows = this.ctx.storage.sql
      .exec<{ fingerprint: string }>("SELECT fingerprint FROM quarantines")
      .toArray();
    for (const row of rows) {
      if (!keep.has(row.fingerprint)) {
        this.ctx.storage.sql.exec(
          "DELETE FROM quarantines WHERE fingerprint = ?",
          row.fingerprint,
        );
      }
    }
  }
}
